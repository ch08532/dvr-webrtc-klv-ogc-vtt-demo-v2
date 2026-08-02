/** Child process that batch-decodes KLV carrier segments, stores telemetry, and writes ordered WebVTT. */
import fs from "node:fs";
import path from "node:path";
import { extractKlvFromTsFile, startKlvIngest, stopKlvIngest } from "./klv_ts_parser.js";
import { SqliteKlvStore } from "../storage/sqlite_klv_store.js";
import { createServiceLogger, serializeError } from "../service_logger.js";

const log = createServiceLogger("klv_stream_worker");
const SEGMENT_POLL_MS = Number(process.env.KLV_SEGMENT_POLL_MS || 500);
const SEGMENT_DECODE_WORKERS = Math.max(1, Math.min(8, Number(process.env.KLV_SEGMENT_DECODE_WORKERS || 4)));
const SEGMENT_DECODE_BATCH_SIZE = Math.max(
  SEGMENT_DECODE_WORKERS,
  Math.min(64, Number(process.env.KLV_SEGMENT_DECODE_BATCH_SIZE || (SEGMENT_DECODE_WORKERS * 4)))
);
const KLV_WRITE_SQLITE = !/^(?:0|false|no|off)$/i.test(String(process.env.KLV_WRITE_SQLITE || "1").trim());

let runtime = null;

/** Left-pads a segment number for stable artifact names. */
function pad(n, w) { return String(n).padStart(w, "0"); }
/** Limits a value to an inclusive range. */
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

/** Formats seconds as a WebVTT cue timestamp. */
function vttTime(seconds) {
  const s = Math.max(0, seconds);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const ms = Math.floor((s - Math.floor(s)) * 1000);
  return `${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)}.${pad(ms, 3)}`;
}

/** Serializes decoded KLV payloads for WebVTT cue text. */
function safeJson(obj) { return JSON.stringify(obj); }

/** Reads HLS media-playlist timing entries used to align KLV with video. */
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

/** Maps an HLS segment URI to its paired VTT artifact name. */
function vttFilenameForSegment(segmentUri) {
  const base = path.basename(segmentUri, path.extname(segmentUri));
  return `meta_${base}.vtt`;
}

/** Writes the VTT HLS playlist for the currently available video window. */
function writeSubtitlePlaylist({ outDir, mediaSequence, targetDurationSec, entries, endList = false }) {
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
  if (endList) txt += "#EXT-X-ENDLIST\n";

  fs.writeFileSync(subtitlePlaylistPath, txt);
}

/** Normalizes decoded KLV timestamps before they are stored or emitted. */
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

/** Posts a structured event from the worker back to its parent client. */
function send(msg) {
  try {
    if (process.connected) process.send?.(msg);
  } catch {}
}

/**
 * Builds the VTT cue payload consumed by the browser telemetry view.
 *
 * A cue carries every decoded ST 0601 value that is present. JSON serialization
 * omits undefined properties, keeping sparse packets compact while ensuring new
 * decoder fields do not need a second, easy-to-miss VTT whitelist update.
 */
function buildVttCuePayload(payload) {
  return { ...payload };
}

/** Writes one VTT file from KLV records that fall within a video segment. */
function writeSegmentVtt({
  outPath,
  durationSec,
  carrierOffsetSec,
  sourceTimelineBaseMs,
  sourceTimelineStartSec,
  videoSegmentOffsetSec,
  transportTimelineBasePts90k,
  records,
  maxCuesPerSecond,
  minCueDurSec,
  maxCueDurSec
}) {
  const segDur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 5;
  const cues = [];
  const total = records.length;
  const segmentTransportStartPts90k = records
    .map((record) => Number(record.transportSegmentStartPts90k))
    .find((pts90k) => Number.isFinite(pts90k));
  const hasTransportTimeline = Number.isFinite(transportTimelineBasePts90k)
    && Number.isFinite(segmentTransportStartPts90k);
  const segmentTimelineStartSec = hasTransportTimeline
    ? Math.max(0, (segmentTransportStartPts90k - transportTimelineBasePts90k) / 90_000)
    : Math.max(0, Number(videoSegmentOffsetSec) || 0);
  const segmentTimelineEndSec = segmentTimelineStartSec + segDur;
  const maxStartSec = Math.max(segmentTimelineStartSec, segmentTimelineEndSec - 0.001);
  const finiteKlvTimes = records
    .filter((r) => r.timeSource === "source_timestamp")
    .map((r) => Number(r.klvUnixMs))
    .filter((ms) => Number.isFinite(ms));
  const relBaseMs = finiteKlvTimes.length ? finiteKlvTimes[0] : null;
  const relativeStartSec = clamp(segmentTimelineStartSec + (Number(carrierOffsetSec) || 0), segmentTimelineStartSec, maxStartSec);
  const hasSourceTimeline = Number.isFinite(sourceTimelineBaseMs)
    && Number.isFinite(sourceTimelineStartSec)
    && Number.isFinite(videoSegmentOffsetSec);

  const computeStartSec = (record, index) => {
    if (hasTransportTimeline && Number.isFinite(record.transportStreamPts90k)) {
      return clamp((record.transportStreamPts90k - transportTimelineBasePts90k) / 90_000, segmentTimelineStartSec, maxStartSec);
    }
    if (hasSourceTimeline && record.timeSource === "source_timestamp" && Number.isFinite(record.klvUnixMs)) {
      const globalSec = sourceTimelineStartSec + ((record.klvUnixMs - sourceTimelineBaseMs) / 1000);
      return clamp(globalSec, segmentTimelineStartSec, maxStartSec);
    }
    if (Number.isFinite(record.klvUnixMs) && Number.isFinite(relBaseMs)) {
      return clamp(relativeStartSec + ((record.klvUnixMs - relBaseMs) / 1000), segmentTimelineStartSec, maxStartSec);
    }
    if (total <= 1) return relativeStartSec;
    return clamp(relativeStartSec + ((index / total) * (segmentTimelineEndSec - relativeStartSec)), segmentTimelineStartSec, maxStartSec);
  };

  let lastCueSecond = null;
  let cueCountThisSecond = 0;
  const selected = [];

  for (let i = 0; i < total; i++) {
    const rec = records[i];
    const cueStartSec = computeStartSec(rec, i);

    const secBucket = Math.floor(cueStartSec);
    if (lastCueSecond !== secBucket) {
      lastCueSecond = secBucket;
      cueCountThisSecond = 0;
    }
    if (cueCountThisSecond >= maxCuesPerSecond) continue;
    cueCountThisSecond++;
    selected.push({ rec, cueStartSec });
  }

  // Ensure starts are strictly increasing to prevent overlap.
  let prevStartSec = -Infinity;
  for (const item of selected) {
    let s = Number(item.cueStartSec);
    if (!Number.isFinite(s)) s = segmentTimelineStartSec;
    if (s <= prevStartSec) s = Math.min(maxStartSec, prevStartSec + 0.001);
    item.cueStartSec = s;
    prevStartSec = s;
  }

  for (let i = 0; i < selected.length; i++) {
    const { rec, cueStartSec } = selected[i];
    const nextStartSec = i + 1 < selected.length ? selected[i + 1].cueStartSec : null;

    let cueEndSec;
    if (Number.isFinite(nextStartSec) && nextStartSec > cueStartSec) {
      // End exactly at the next cue start: no overlap.
      cueEndSec = Math.min(segmentTimelineEndSec, nextStartSec);
    } else {
      cueEndSec = Math.min(segmentTimelineEndSec, cueStartSec + clamp(minCueDurSec, 0.001, maxCueDurSec));
    }
    if (!(cueEndSec > cueStartSec)) {
      cueEndSec = Math.min(segmentTimelineEndSec, cueStartSec + 0.001);
    }

    const payload = buildVttCuePayload(rec.decoded);

    cues.push(
      `${vttTime(cueStartSec)} --> ${vttTime(cueEndSec)}\n${safeJson(payload)}\n\n`
    );
  }

  let content = "WEBVTT\n\n";
  for (const cue of cues) content += cue;
  fs.writeFileSync(outPath, content);
}

/** Finds the KLV-carrier segment corresponding to a browser video segment. */
function findCarrierEntry(videoEntry, carrierEntries) {
  const sameSequence = carrierEntries.find((entry) => entry.sequence === videoEntry.sequence);
  if (sameSequence) return sameSequence;

  if (!Number.isFinite(videoEntry.pdtMs)) return null;
  const maxDifferenceMs = Math.max(1, Number(videoEntry.durationSec) || 1) * 2_000;
  let closest = null;
  let closestDifferenceMs = Infinity;

  for (const entry of carrierEntries) {
    if (!Number.isFinite(entry.pdtMs)) continue;
    const differenceMs = Math.abs(entry.pdtMs - videoEntry.pdtMs);
    if (differenceMs < closestDifferenceMs) {
      closest = entry;
      closestDifferenceMs = differenceMs;
    }
  }

  return closestDifferenceMs <= maxDifferenceMs ? closest : null;
}

/** Parses one completed carrier segment without mutating ordered timeline state. */
async function decodeSegmentEntry(current, videoEntry, carrierEntry) {
  const tsPath = path.join(current.outDir, carrierEntry.uri);
  if (!fs.existsSync(tsPath)) return null;
  const decodedItems = await extractKlvFromTsFile({
    streamId: current.streamId,
    inputPath: tsPath,
    requestId: current.requestId
  });
  return { videoEntry, carrierEntry, decodedItems };
}

/** Prepares one decoded segment in playlist order so timeline alignment stays stable. */
function prepareSegmentEntry(current, decodedSegment) {
  const { videoEntry, carrierEntry, decodedItems } = decodedSegment;
  const videoSegmentOffsetSec = getVideoSegmentOffsetSec(current, videoEntry);
  const vttFile = vttFilenameForSegment(videoEntry.uri);
  const vttPath = path.join(current.outDir, vttFile);

  const records = [];
  for (const decoded of decodedItems) {
    const enriched = enrichDecodedTimestamp(decoded);
    records.push({
      decoded: enriched.decoded,
      klvUnixMs: enriched.klvUnixMs,
      timeSource: enriched.timeSource,
      transportStreamPts90k: Number(decoded.transportStreamPts90k),
      transportSegmentStartPts90k: Number(decoded.transportSegmentStartPts90k)
    });
  }

  const carrierOffsetSec = Number.isFinite(carrierEntry.pdtMs) && Number.isFinite(videoEntry.pdtMs)
    ? (carrierEntry.pdtMs - videoEntry.pdtMs) / 1000
    : 0;
  const firstSourceRecord = records.find((record) => (
    record.timeSource === "source_timestamp" && Number.isFinite(record.klvUnixMs)
  ));
  if (current.sourceTimelineBaseMs == null && firstSourceRecord) {
    current.sourceTimelineBaseMs = firstSourceRecord.klvUnixMs;
    current.sourceTimelineStartSec = videoSegmentOffsetSec + carrierOffsetSec;
  }
  const firstTransportRecord = records.find((record) => Number.isFinite(record.transportSegmentStartPts90k));
  if (current.transportTimelineBasePts90k == null && firstTransportRecord) {
    current.transportTimelineBasePts90k = firstTransportRecord.transportSegmentStartPts90k;
  }

  return { videoEntry, vttFile, vttPath, videoSegmentOffsetSec, carrierOffsetSec, records };
}

/** Writes VTT for an already decoded and storage-committed segment. */
function writePreparedSegmentVtt(current, prepared) {
  writeSegmentVtt({
    outPath: prepared.vttPath,
    durationSec: prepared.videoEntry.durationSec,
    carrierOffsetSec: prepared.carrierOffsetSec,
    sourceTimelineBaseMs: current.sourceTimelineBaseMs,
    sourceTimelineStartSec: current.sourceTimelineStartSec,
    videoSegmentOffsetSec: prepared.videoSegmentOffsetSec,
    transportTimelineBasePts90k: current.transportTimelineBasePts90k,
    records: prepared.records,
    maxCuesPerSecond: current.maxCuesPerSecond,
    minCueDurSec: current.minCueDurSec,
    maxCueDurSec: current.maxCueDurSec
  });

  log.debug("segment_processed", {
    requestId: current.requestId,
    streamId: current.streamId,
    vttFile: prepared.vttFile,
    videoSequence: prepared.videoEntry.sequence,
    decodedCount: prepared.records.length
  });
}

/** Runs asynchronous segment parsing with a bounded pool to limit disk pressure. */
async function decodeSegmentBatch(current, entries) {
  const results = new Array(entries.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(SEGMENT_DECODE_WORKERS, entries.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= entries.length) return;
      const entry = entries[index];
      results[index] = await decodeSegmentEntry(current, entry.videoEntry, entry.carrierEntry);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Derives the source-time offset of a video segment from HLS timing data. */
function getVideoSegmentOffsetSec(current, videoEntry) {
  if (current.timelineBaseSequence == null) current.timelineBaseSequence = videoEntry.sequence;
  if (current.timelineBasePdtMs == null && Number.isFinite(videoEntry.pdtMs)) {
    current.timelineBasePdtMs = videoEntry.pdtMs;
  }
  if (Number.isFinite(videoEntry.pdtMs) && Number.isFinite(current.timelineBasePdtMs)) {
    return Math.max(0, (videoEntry.pdtMs - current.timelineBasePdtMs) / 1000);
  }
  const durationSec = Number(videoEntry.durationSec) || current.segmentSeconds;
  return Math.max(0, (videoEntry.sequence - current.timelineBaseSequence) * durationSec);
}

/** Polls playlists and processes every video segment not handled yet. */
async function processPendingSegments() {
  const current = runtime;
  if (!current || current.processing) return;
  current.processing = true;
  try {
    const videoPlaylist = parseVideoPlaylist(current.videoPlaylistPath);
    const carrierPlaylist = parseVideoPlaylist(current.carrierPlaylistPath);
    if (!videoPlaylist || !carrierPlaylist || !videoPlaylist.entries.length || !carrierPlaylist.entries.length) return;

    while (true) {
      const batch = [];
      for (const videoEntry of videoPlaylist.entries) {
        if (current.lastProcessedSequence != null && videoEntry.sequence <= current.lastProcessedSequence) continue;
        const carrierEntry = findCarrierEntry(videoEntry, carrierPlaylist.entries);
        if (!carrierEntry || !fs.existsSync(path.join(current.outDir, carrierEntry.uri))) break;
        batch.push({ videoEntry, carrierEntry });
        if (batch.length >= SEGMENT_DECODE_BATCH_SIZE) break;
      }
      if (!batch.length) break;

      const decodedBatch = await decodeSegmentBatch(current, batch);
      if (decodedBatch.some((item) => !item)) break;

      // Build timing state in sequence order. SQLite storage is normally
      // committed before publishing VTT sidecars, but can be disabled for
      // profiling without affecting KLV decode or subtitle generation.
      const preparedBatch = decodedBatch.map((item) => prepareSegmentEntry(current, item));
      const decodedForStorage = preparedBatch.flatMap((item) => item.records.map((record) => record.decoded));
      const sourceTimestampRecords = preparedBatch
        .flatMap((item) => item.records)
        .filter((record) => record.timeSource === "source_timestamp" && Number.isFinite(record.klvUnixMs));
      if (current.writeSqlite) {
        await current.store.addMany(current.streamId, decodedForStorage, {
          isEphemeral: current.sourceType !== "file"
        });
      } else {
        log.debug("sqlite_write_skipped", {
          requestId: current.requestId,
          streamId: current.streamId,
          decodedCount: decodedForStorage.length
        });
      }
      if (sourceTimestampRecords.length && Number.isFinite(current.sourceTimelineBaseMs) && Number.isFinite(current.sourceTimelineStartSec)) {
        await current.store.updateMissionTimeline(current.streamId, {
          missionBaseMs: current.sourceTimelineBaseMs,
          videoBaseMs: Math.round(current.sourceTimelineStartSec * 1000),
          missionMinMs: Math.min(...sourceTimestampRecords.map((record) => record.klvUnixMs)),
          missionMaxMs: Math.max(...sourceTimestampRecords.map((record) => record.klvUnixMs))
        });
      }

      for (const prepared of preparedBatch) {
        writePreparedSegmentVtt(current, prepared);
        current.lastProcessedSequence = prepared.videoEntry.sequence;
      }

      if (batch.length < SEGMENT_DECODE_BATCH_SIZE) break;
    }

    writeSubtitlePlaylist({
      outDir: current.outDir,
      mediaSequence: videoPlaylist.mediaSequence,
      targetDurationSec: videoPlaylist.targetDurationSec,
      entries: videoPlaylist.entries
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

/** Initializes worker state and begins polling HLS artifacts for new segments. */
async function start(message) {
  const {
    streamId,
    inputUrl,
    sourceType,
    outDir,
    videoPlaylistName,
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

  const videoPlaylistPath = path.join(outDir, videoPlaylistName || "v0/index.m3u8");
  const carrierPlaylistPath = path.join(outDir, "playlist.m3u8");
  const segmentPollTimer = setInterval(() => {
    processPendingSegments().catch(() => {});
  }, SEGMENT_POLL_MS);

  runtime = {
    streamId,
    requestId,
    inputUrl,
    sourceType: sourceType === "file" ? "file" : "stream",
    outDir,
    videoPlaylistPath,
    carrierPlaylistPath,
    segmentSeconds,
    maxCuesPerSecond: Number(maxCuesPerSecond) || 10,
    minCueDurSec: Number(minCueDurSec) || 0.10,
    maxCueDurSec: Number(maxCueDurSec) || 0.50,
    writeSqlite: KLV_WRITE_SQLITE,
    store,
    segmentPollTimer,
    processing: false,
    lastProcessedSequence: null,
    timelineBaseSequence: null,
    timelineBasePdtMs: null,
    sourceTimelineBaseMs: null,
    sourceTimelineStartSec: null,
    transportTimelineBasePts90k: null,
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

  log.info("start", { requestId, streamId, sourceType: runtime.sourceType, writeSqlite: runtime.writeSqlite });
  await processPendingSegments();
  send({ type: "started", streamId });
}

/** Stops playlist polling and releases active worker resources. */
async function stop() {
  if (!runtime) return;
  const current = runtime;
  runtime = null;

  if (current.segmentPollTimer) clearInterval(current.segmentPollTimer);
  await stopKlvIngest(current.liveIngestHandle);
  await current.store?.close();

  send({ type: "stopped", streamId: current.streamId });
}

/** Processes remaining finite-file segments and writes final HLS end markers. */
async function finalize(finalizeId) {
  const current = runtime;
  if (!current) throw new Error("worker is not started");
  while (current.processing) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await processPendingSegments();
  const videoPlaylist = parseVideoPlaylist(current.videoPlaylistPath);
  if (!videoPlaylist) throw new Error("video HLS playlist is unavailable for VTT finalization");
  writeSubtitlePlaylist({
    outDir: current.outDir,
    mediaSequence: videoPlaylist.mediaSequence,
    targetDurationSec: videoPlaylist.targetDurationSec,
    entries: videoPlaylist.entries,
    endList: true
  });
  send({ type: "finalized", streamId: current.streamId, finalizeId });
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
    if (message.type === "finalize") {
      await finalize(message.finalizeId);
      return;
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
