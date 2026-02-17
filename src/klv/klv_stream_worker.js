import path from "node:path";
import { startKlvIngest, stopKlvIngest } from "./klv_ts_parser.js";
import { SqliteKlvStore } from "../storage/sqlite_klv_store.js";
import { SegmentedVttWriter } from "../vtt_segmenter.js";
import { readHlsPdtWindowMs } from "../hls_window.js";
import { createServiceLogger, serializeError } from "../service_logger.js";

const log = createServiceLogger("klv_stream_worker");

let runtime = null;

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
  const vtt = new SegmentedVttWriter({
    outDir,
    segmentSeconds,
    maxCuesPerSecond,
    minCueDurSec,
    maxCueDurSec
  });

  const vttWindowTimer = setInterval(() => {
    const w = readHlsPdtWindowMs(playlistPath);
    if (!w) return;
    vtt.setWindow(w.firstMs, w.lastMs);
  }, 500);

  const klv = await startKlvIngest({
    streamId,
    inputUrl,
    requestId,
    onDecoded: async (decoded) => {
      try {
        const enriched = enrichDecodedTimestamp(decoded);
        await store.add(streamId, enriched.decoded);
        vtt.addKlv({ klvUnixMs: enriched.klvUnixMs, payload: enriched.decoded });
        send({
          type: "decoded",
          streamId,
          decoded: enriched.decoded,
          klvUnixMs: enriched.klvUnixMs,
          timeSource: enriched.timeSource
        });
      } catch (error) {
        send({
          type: "error",
          streamId,
          error: serializeError(error)
        });
      }
    }
  });

  runtime = {
    streamId,
    requestId,
    store,
    vtt,
    vttWindowTimer,
    klv
  };

  send({ type: "started", streamId });
}

async function stop() {
  if (!runtime) return;
  const current = runtime;
  runtime = null;

  if (current.vttWindowTimer) clearInterval(current.vttWindowTimer);
  try { await current.vtt?.flushNow(); } catch {}
  await stopKlvIngest(current.klv);
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
