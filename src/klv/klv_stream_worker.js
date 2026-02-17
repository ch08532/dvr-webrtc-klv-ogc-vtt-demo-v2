import fs from "node:fs";
import path from "node:path";
import { extractKlvFromTsFile, startKlvIngest, stopKlvIngest } from "./klv_ts_parser.js";
import { SqliteKlvStore } from "../storage/sqlite_klv_store.js";
import { createServiceLogger, serializeError } from "../service_logger.js";

const log = createServiceLogger("klv_stream_worker");
const SEGMENT_POLL_MS = Number(process.env.KLV_SEGMENT_POLL_MS || 500);

let runtime = null;

function pad(n, w) { return String(n).padStart(w, "0"); }
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function vttTime(seconds) {
  const s = Math.max(0, seconds);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const ms = Math.floor((s - Math.floor(s)) * 1000);
  return `${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)}.${pad(ms, 3)}`;
}

function safeJson(obj, maxLen = 950) {
  let s = JSON.stringify(obj);
  if (s.length > maxLen) s = s.slice(0, maxLen) + "…";
  return s;
}

function parseVideoPlaylist(playlistPath) {
  try {
    const txt = fs.readFileSync(playlistPath, "utf8");
    const lines = txt.split(/\r?\n/).map((x) => x.trim()).filter((x) => x.length);
    const entries = [];

    let mediaSequence = 0;
    let targetDurationSec = 1;
    let currentPdtMs = null;
    let currentPdtRaw = null;
    let currentDurSec = null;
    let currentDurRaw = null;

    for (const line of lines) {
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        const n = Number(line.slice("#EXT-X-MEDIA-SEQUENCE:".length).trim());
        mediaSequence = Number.isFinite(n) ? n : mediaSequence;
        continue;
      }
      if (line.startsWith("#EXT-X-TARGETDURATION:")) {
        const n = Number(line.slice("#EXT-X-TARGETDURATION:".length).trim());
        if (Number.isFinite(n) && n > 0) targetDurationSec = n;
        continue;
      }
      if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
        const raw = line.slice("#EXT-X-PROGRAM-DATE-TIME:".length).trim();
        const parsed = Date.parse(raw);
        currentPdtMs = Number.isFinite(parsed) ? parsed : null;
        currentPdtRaw = raw;
        continue;
      }
      if (line.startsWith("#EXTINF:")) {
        const raw = line.slice("#EXTINF:".length).split(",")[0].trim();
        const n = Number(raw);
        currentDurSec = Number.isFinite(n) && n > 0 ? n : null;
        currentDurRaw = raw;
        continue;
      }
      if (line.startsWith("#")) continue;

      const index = entries.length;
      entries.push({
        uri: line,
        sequence: mediaSequence + index,
        pdtMs: currentPdtMs,
        pdtRaw: currentPdtRaw,
        durationSec: currentDurSec ?? targetDurationSec,
        durationRaw: currentDurRaw
      });
      currentPdtMs = null;
      currentPdtRaw = null;
      currentDurSec = null;
      currentDurRaw = null;
    }

    return { entries, mediaSequence, targetDurationSec };
  } catch {
    return null;
  }
}

function vttFilenameForSegment(segmentUri) {
  const base = path.basename(segmentUri, path.extname(segmentUri));
  return `meta_${base}.vtt`;
}

function segmentIndexFromUri(segmentUri) {
  const base = path.basename(segmentUri, path.extname(segmentUri));
  const match = base.match(/(\d+)$/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function writeSubtitlePlaylist({ outDir, mediaSequence, targetDurationSec, entries }) {
  const subtitlePlaylistPath = path.join(outDir, "subtitles.m3u8");
  const target = Math.max(1, Math.ceil(Number(targetDurationSec) || 1));
  const published = [];

  for (const entry of entries) {
    const vttFile = vttFilenameForSegment(entry.uri);
    const vttPath = path.join(outDir, vttFile);
    if (!fs.existsSync(vttPath)) continue;
    published.push({ entry, vttFile });
  }
  const seq = published.length ? published[0].entry.sequence : mediaSequence;

  let txt = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:${target}
#EXT-X-MEDIA-SEQUENCE:${seq}
#EXT-X-PLAYLIST-TYPE:VOD
`;

  for (const { entry, vttFile } of published) {
    const dur = Number(entry.durationSec);
    const durationSec = Number.isFinite(dur) && dur > 0 ? dur : target;
    const durationText = typeof entry.durationRaw === "string" && entry.durationRaw.length
      ? entry.durationRaw
      : durationSec.toFixed(3);
    txt += `#EXTINF:${durationText},\n`;
    txt += `${vttFile}\n`;
  }

  fs.writeFileSync(subtitlePlaylistPath, txt);
}

function enrichDecodedTimestamp(decoded) {
  const nowMs = Date.now();
  const ingestMs = nowMs;
  const ingestMicros = (BigInt(ingestMs) * 1000n).toString();
  const ingestIso = new Date(ingestMs).toISOString();

  let sourceClockMs = null;
  if (decoded?.timestampUnixMicros != null) {
    try {
      const micros = BigInt(decoded.timestampUnixMicros);
      const ms = Number(micros / 1000n);
      if (Number.isFinite(ms)) sourceClockMs = ms;
    } catch {
      // preserve decoded timestamps as-is; fall back below if unusable
    }
  }
  if (sourceClockMs == null && typeof decoded?.timestampIso === "string") {
    const parsed = Date.parse(decoded.timestampIso);
    if (Number.isFinite(parsed)) sourceClockMs = parsed;
  }

  const useSourceClock = sourceClockMs != null;
  const eventMs = useSourceClock ? sourceClockMs : ingestMs;

  return {
    decoded: {
      ...decoded,
      ingestTimestampUnixMicros: ingestMicros,
      ingestTimestampIso: ingestIso
    },
    klvUnixMs: eventMs,
    timeSource: useSourceClock ? "source_timestamp" : "ingest_wall_clock"
  };
}

function send(msg) {
  try {
    if (process.connected) process.send?.(msg);
  } catch {}
}

function buildVttCuePayload(payload) {
  return {
    timestampIso: payload.timestampIso,
    ingestTimestampIso: payload.ingestTimestampIso,
    ingestTimestampUnixMicros: payload.ingestTimestampUnixMicros,
    sensorLat: payload.sensorLat,
    sensorLon: payload.sensorLon,
    frameCenterLat: payload.frameCenterLat,
    frameCenterLon: payload.frameCenterLon,
    platformHeadingDeg: payload.platformHeadingDeg,
    sensorHfovDeg: payload.sensorHfovDeg,
    sensorVfovDeg: payload.sensorVfovDeg,
    slantRangeM: payload.slantRangeM
  };
}

function writeSegmentVtt({
  outPath,
  durationSec,
  segmentStartMs,
  segmentOffsetSec,
  records,
  maxCuesPerSecond,
  minCueDurSec,
  maxCueDurSec
}) {
  const segDur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 5;
  const cues = [];
  const total = records.length;
  const finiteKlvTimes = records
    .map((r) => Number(r.klvUnixMs))
    .filter((ms) => Number.isFinite(ms));
  const relBaseMs = finiteKlvTimes.length ? finiteKlvTimes[0] : null;
  let useAbsoluteClock = false;
  if (Number.isFinite(segmentStartMs) && finiteKlvTimes.length) {
    const first = finiteKlvTimes[0];
    const last = finiteKlvTimes[finiteKlvTimes.length - 1];
    const minExpected = segmentStartMs - 1000;
    const maxExpected = segmentStartMs + (segDur * 1000) + 1000;
    useAbsoluteClock = first >= minExpected && first <= maxExpected && last >= minExpected && last <= maxExpected;
  }

  const computeStartSec = (record, index) => {
    if (Number.isFinite(record.klvUnixMs) && useAbsoluteClock) {
      return clamp((record.klvUnixMs - segmentStartMs) / 1000, 0, Math.max(0, segDur - 0.001));
    }
    if (Number.isFinite(record.klvUnixMs) && Number.isFinite(relBaseMs)) {
      return clamp((record.klvUnixMs - relBaseMs) / 1000, 0, Math.max(0, segDur - 0.001));
    }
    if (total <= 1) return 0;
    return clamp((index / total) * segDur, 0, Math.max(0, segDur - 0.001));
  };

  let lastCueSecond = null;
  let cueCountThisSecond = 0;

  for (let i = 0; i < total; i++) {
    const rec = records[i];
    const cueStartSec = computeStartSec(rec, i);
    const nextStartSec = i + 1 < total ? computeStartSec(records[i + 1], i + 1) : null;

    const secBucket = Math.floor(cueStartSec);
    if (lastCueSecond !== secBucket) {
      lastCueSecond = secBucket;
      cueCountThisSecond = 0;
    }
    if (cueCountThisSecond >= maxCuesPerSecond) continue;
    cueCountThisSecond++;

    const dtSec = Number.isFinite(nextStartSec) && nextStartSec > cueStartSec
      ? (nextStartSec - cueStartSec)
      : 0.1;
    const cueDur = clamp(dtSec * 1.2, minCueDurSec, maxCueDurSec);
    const cueStartGlobalSec = Math.max(0, Number(segmentOffsetSec) + cueStartSec);
    const cueEndGlobalSec = Math.min(
      Math.max(0, Number(segmentOffsetSec) + segDur),
      cueStartGlobalSec + cueDur
    );
    const payload = buildVttCuePayload(rec.decoded);

    cues.push(
      `${vttTime(cueStartGlobalSec)} --> ${vttTime(cueEndGlobalSec)}\n${safeJson(payload)}\n\n`
    );
  }

  let content = "WEBVTT\n\n";
  for (const cue of cues) content += cue;
  fs.writeFileSync(outPath, content);
}

async function processSegmentEntry(current, entry, segmentOffsetSec) {
  const tsPath = path.join(current.outDir, entry.uri);
  if (!fs.existsSync(tsPath)) return false;

  const vttFile = vttFilenameForSegment(entry.uri);
  const vttPath = path.join(current.outDir, vttFile);
  const decodedItems = await extractKlvFromTsFile({
    streamId: current.streamId,
    inputPath: tsPath,
    requestId: current.requestId
  });

  const records = [];
  for (const decoded of decodedItems) {
    const enriched = enrichDecodedTimestamp(decoded);
    await current.store.add(current.streamId, enriched.decoded);
    records.push({
      decoded: enriched.decoded,
      klvUnixMs: enriched.klvUnixMs,
      timeSource: enriched.timeSource
    });
  }

  writeSegmentVtt({
    outPath: vttPath,
    durationSec: entry.durationSec,
    segmentStartMs: entry.pdtMs,
    segmentOffsetSec,
    records,
    maxCuesPerSecond: current.maxCuesPerSecond,
    minCueDurSec: current.minCueDurSec,
    maxCueDurSec: current.maxCueDurSec
  });

  log.debug("segment_processed", {
    requestId: current.requestId,
    streamId: current.streamId,
    tsFile: entry.uri,
    vttFile,
    segmentOffsetSec,
    decodedCount: decodedItems.length
  });
  return true;
}

async function processPendingSegments() {
  const current = runtime;
  if (!current || current.processing) return;
  current.processing = true;
  try {
    const parsed = parseVideoPlaylist(current.playlistPath);
    if (!parsed || !parsed.entries.length) return;

    for (const entry of parsed.entries) {
      if (current.lastProcessedSequence != null && entry.sequence <= current.lastProcessedSequence) {
        continue;
      }
      if (current.timelineBaseSequence == null) {
        current.timelineBaseSequence = entry.sequence;
      }
      if (current.timelineBasePdtMs == null && Number.isFinite(entry.pdtMs)) {
        current.timelineBasePdtMs = entry.pdtMs;
      }
      const durationHint = Number.isFinite(entry.durationSec) && entry.durationSec > 0
        ? entry.durationSec
        : current.segmentSeconds;
      const segmentIndex = segmentIndexFromUri(entry.uri);
      const segmentOffsetSec = Number.isFinite(segmentIndex)
        ? Math.max(0, segmentIndex * current.segmentSeconds)
        : Number.isFinite(entry.pdtMs) && Number.isFinite(current.timelineBasePdtMs)
          ? Math.max(0, (entry.pdtMs - current.timelineBasePdtMs) / 1000)
          : Math.max(0, (entry.sequence - current.timelineBaseSequence) * durationHint);

      const done = await processSegmentEntry(current, entry, segmentOffsetSec);
      if (!done) break;
      current.lastProcessedSequence = entry.sequence;
    }

    writeSubtitlePlaylist({
      outDir: current.outDir,
      mediaSequence: parsed.mediaSequence,
      targetDurationSec: parsed.targetDurationSec,
      entries: parsed.entries
    });
  } catch (error) {
    send({
      type: "error",
      streamId: current.streamId,
      error: serializeError(error)
    });
  } finally {
    if (runtime) runtime.processing = false;
  }
}

async function start(message) {
  const {
    streamId,
    inputUrl,
    outDir,
    segmentSeconds,
    maxCuesPerSecond,
    minCueDurSec,
    maxCueDurSec,
    dbPath,
    requestId
  } = message;

  if (runtime) throw new Error("worker already started");

  const store = new SqliteKlvStore({ dbPath });
  await store.init();

  const playlistPath = path.join(outDir, "playlist.m3u8");
  const segmentPollTimer = setInterval(() => {
    processPendingSegments().catch(() => {});
  }, SEGMENT_POLL_MS);

  runtime = {
    streamId,
    requestId,
    inputUrl,
    outDir,
    playlistPath,
    segmentSeconds,
    maxCuesPerSecond: Number(maxCuesPerSecond) || 10,
    minCueDurSec: Number(minCueDurSec) || 0.10,
    maxCueDurSec: Number(maxCueDurSec) || 0.50,
    store,
    segmentPollTimer,
    processing: false,
    lastProcessedSequence: null,
    timelineBaseSequence: null,
    timelineBasePdtMs: null,
    liveIngestHandle: null
  };

  runtime.liveIngestHandle = await startKlvIngest({
    streamId,
    inputUrl,
    requestId,
    onDecoded: (decoded) => {
      if (!runtime) return;
      const enriched = enrichDecodedTimestamp(decoded);
      send({
        type: "decoded",
        streamId: runtime.streamId,
        decoded: enriched.decoded,
        klvUnixMs: enriched.klvUnixMs,
        timeSource: enriched.timeSource
      });
    }
  });

  await processPendingSegments();
  send({ type: "started", streamId });
}

async function stop() {
  if (!runtime) return;
  const current = runtime;
  runtime = null;

  if (current.segmentPollTimer) clearInterval(current.segmentPollTimer);
  await stopKlvIngest(current.liveIngestHandle);
  await current.store?.close();

  send({ type: "stopped", streamId: current.streamId });
}

process.on("message", async (message) => {
  if (!message || typeof message !== "object") return;
  try {
    if (message.type === "start") {
      await start(message);
      return;
    }
    if (message.type === "stop") {
      await stop();
      process.exit(0);
    }
  } catch (error) {
    const streamId = runtime?.streamId || message.streamId;
    log.error("worker_error", { streamId, error: serializeError(error) });
    send({
      type: "error",
      streamId,
      error: serializeError(error)
    });
    process.exit(1);
  }
});

process.on("disconnect", async () => {
  try { await stop(); } catch {}
  process.exit(0);
});

process.on("SIGTERM", async () => {
  try { await stop(); } catch {}
  process.exit(0);
});

send({ type: "worker_ready" });
