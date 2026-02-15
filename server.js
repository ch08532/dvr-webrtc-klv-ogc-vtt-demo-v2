import express from "express";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { WebSocketServer } from "ws";

import { createWebRtcSfu } from "./src/webrtc_sfu.js";
import { startHlsRecorder, stopHlsRecorder } from "./src/hls_recorder.js";
import { startFfmpegRtpIngest, stopFfmpegRtpIngest } from "./src/ffmpeg_rtp_ingest.js";
import { startKlvIngest, stopKlvIngest } from "./src/klv/klv_ts_parser.js";
import { SqliteKlvStore } from "./src/storage/sqlite_klv_store.js";
import { registerOgcMovingFeaturesRoutes } from "./src/ogc_moving_features.js";
import { SegmentedVttWriter } from "./src/vtt_segmenter.js";
import { readHlsPdtWindowMs } from "./src/hls_window.js";
import {
  createServiceLogger,
  newRequestId,
  runWithLogContext,
  serializeError
} from "./src/service_logger.js";

const HTTP_PORT = 8090;
const WS_PORT = 8081;
const WEBRTC_ANNOUNCED_IP = process.env.WEBRTC_ANNOUNCED_IP || "127.0.0.1";
const log = createServiceLogger("server");

const RECORD_ROOT = path.resolve("./recordings");
const DB_DIR = path.resolve("./db");

fs.mkdirSync(RECORD_ROOT, { recursive: true });
fs.mkdirSync(DB_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  const headerId = req.headers["x-request-id"];
  const requestId = typeof headerId === "string" && headerId.trim()
    ? headerId.trim()
    : newRequestId();

  res.setHeader("X-Request-Id", requestId);

  runWithLogContext({ requestId }, () => {
    req.requestId = requestId;
    log.debug("request_start", { method: req.method, path: req.originalUrl });
    res.on("finish", () => {
      log.debug("request_end", {
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode
      });
    });
    next();
  });
});
const server = http.createServer(app);

// ---------- Storage ----------
const store = new SqliteKlvStore({ dbPath: path.join(DB_DIR, "klv.sqlite") });
await store.init();
store.startRetentionJob({ maxAgeMs: 2 * 60 * 60 * 1000 }); // keep 2h (demo)

// ---------- WebRTC SFU ----------
const sfu = await createWebRtcSfu({
  announcedIp: WEBRTC_ANNOUNCED_IP,
  rtcMinPort: 40000,
  rtcMaxPort: 49999
});

// ---------- Sources ----------
/**
 * sources map entry:
 * {
 *   streamId, inputUrl, mode, dvrSeconds, vttSegmentSeconds,
 *   hlsSegmentSeconds,
 *   hls, klv,
 *   vtt, vttWindowTimer,
 *   webrtc: { ingestProc, producerId }
 * }
 */
const sources = new Map();
const sourceStates = new Map();

function isProcessRunning(proc) {
  return !!proc && proc.exitCode == null && !proc.killed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSegmentSeconds(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function setSourceState(streamId, patch) {
  const prev = sourceStates.get(streamId) || {
    streamId,
    state: "stopped",
    running: false,
    lastError: null,
    updatedAt: new Date().toISOString()
  };
  const next = {
    ...prev,
    ...patch,
    streamId,
    updatedAt: new Date().toISOString()
  };
  sourceStates.set(streamId, next);
  return next;
}

async function purgeSourceArtifacts(streamId) {
  const outDir = path.join(RECORD_ROOT, streamId);
  const sdpFile = path.join(DB_DIR, `${streamId}.sdp`);

  try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(outDir, { recursive: true });
  try { fs.rmSync(sdpFile, { force: true }); } catch {}

  const deletedEvents = await store.purgeStream(streamId);
  return { outDir, sdpFile, deletedEvents };
}

function getSourceRuntime(streamId) {
  const tracked = sourceStates.get(streamId);
  const source = sources.get(streamId);

  if (!source) {
    return {
      streamId,
      state: tracked?.state || "stopped",
      running: false,
      lastError: tracked?.lastError || null,
      updatedAt: tracked?.updatedAt || new Date().toISOString()
    };
  }

  const hlsRunning = isProcessRunning(source.hls?.proc);
  const klvRunning = !!source.klv?.input && !source.klv.input.destroyed;
  const ingestRunning = isProcessRunning(source.webrtc?.ingestProc?.proc);
  const running = hlsRunning;

  let state = tracked?.state || "running";
  if (state === "starting" || state === "stopping") {
    // honor explicit transition state
  } else if (hlsRunning && klvRunning && ingestRunning) {
    state = "running";
  } else if (hlsRunning) {
    state = "degraded";
  } else if (state !== "starting" && state !== "stopping") {
    state = "error";
  }

  return {
    streamId,
    state,
    running,
    hlsRunning,
    klvRunning,
    ingestRunning,
    lastError: tracked?.lastError || null,
    updatedAt: tracked?.updatedAt || new Date().toISOString()
  };
}

function normalizeDecodedTimestamp(decoded) {
  const nowMs = Date.now();
  const ingestMs = nowMs;
  const ingestMicros = (BigInt(ingestMs) * 1000n).toString();

  let videoClockUnixMicros = null;
  let videoClockIso = null;
  if (decoded?.timestampUnixMicros != null) {
    try {
      videoClockUnixMicros = String(decoded.timestampUnixMicros);
      const ms = Number(BigInt(videoClockUnixMicros) / 1000n);
      if (Number.isFinite(ms)) videoClockIso = new Date(ms).toISOString();
    } catch {
      videoClockUnixMicros = String(decoded.timestampUnixMicros);
      videoClockIso = null;
    }
  }

  return {
    decoded: {
      ...decoded,
      // Keep ingest wall clock as primary time axis for storage/overlay alignment.
      timestampUnixMicros: ingestMicros,
      timestampIso: new Date(ingestMs).toISOString(),
      ingestTimestampUnixMicros: ingestMicros,
      ingestTimestampIso: new Date(ingestMs).toISOString(),
      videoClockTimestampUnixMicros: videoClockUnixMicros,
      videoClockTimestampIso: videoClockIso
    },
    klvUnixMs: ingestMs,
    timeSource: "ingest_wall_clock"
  };
}

// ---------- WebSocket for LIVE KLV (optional) ----------
const wss = new WebSocketServer({ port: WS_PORT });
console.log(`[ws]  ws://localhost:${WS_PORT}`);

function wsBroadcastLive(streamId, decoded) {
  const msg = JSON.stringify({ type: "st0601", streamId, ...decoded });
  for (const c of wss.clients) {
    if (c.readyState !== 1) continue;
    if (!c._sub?.streamId || c._sub.streamId !== streamId) continue;
    if (c._sub.mode !== "live") continue;
    c.send(msg);
  }
}

wss.on("connection", (ws) => {
  log.info("ws_connected", { clients: wss.clients.size });
  ws._sub = { streamId: null, mode: "live" };
  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "subscribe") {
      ws._sub = { streamId: msg.streamId, mode: msg.mode || "live" };
      log.info("ws_subscribe", { streamId: ws._sub.streamId, mode: ws._sub.mode });
      if (ws._sub.streamId) {
        const last = await store.latest(ws._sub.streamId);
        if (last) ws.send(JSON.stringify({ type: "st0601", streamId: ws._sub.streamId, ...last.data }));
      }
    }
  });
  ws.on("close", () => {
    log.info("ws_disconnected", { clients: wss.clients.size });
  });
});

// ---------- Static UI + HLS ----------
app.use("/", express.static(path.resolve("./public"), { setHeaders(res) { res.setHeader("Cache-Control", "no-cache"); } }));
app.use("/hls", express.static(RECORD_ROOT, {
  setHeaders(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-cache");
  }
}));

// ---------- OGC Moving Features subset ----------
registerOgcMovingFeaturesRoutes(app, { sources, store });

// ---------- API: sources ----------
app.get("/sources", (req, res) => {
  const list = [...sources.values()].map(s => ({
    streamId: s.streamId,
    inputUrl: s.inputUrl,
    mode: s.mode,
    dvrSeconds: s.dvrSeconds,
    hlsSegmentSeconds: s.hlsSegmentSeconds,
    vttSegmentSeconds: s.vttSegmentSeconds,
    hlsMasterUrl: `/hls/${s.streamId}/master.m3u8`,
    webrtcReady: !!s.webrtc?.producerId,
    ...getSourceRuntime(s.streamId)
  }));
  res.json(list);
});

app.get("/sources/:streamId/state", (req, res) => {
  res.json(getSourceRuntime(req.params.streamId));
});

app.post("/sources", async (req, res) => {
  let requestedStreamId = null;
  let hls = null;
  let klv = null;
  let vtt = null;
  let vttWindowTimer = null;
  let ingestProc = null;
  let createdInSfu = false;
  let purgeResult = null;

  try {
    const {
  streamId,
  inputUrl,
  mode = "xcode-any",
  dvrSeconds = 600,
  hlsSegmentSeconds = 1,
  vttSegmentSeconds = 5,
  purgeBeforeStart = false,

  // Variable-rate VTT tuning
  maxCuesPerSecond = 10,
  minCueDurSec = 0.10,
  maxCueDurSec = 0.50
} = req.body || {};
    requestedStreamId = streamId;
    const effectiveSegmentSeconds = normalizeSegmentSeconds(
      hlsSegmentSeconds,
      normalizeSegmentSeconds(vttSegmentSeconds, 1)
    );

    if (!streamId || !inputUrl) throw new Error("streamId and inputUrl required");
    if (sources.has(streamId)) throw new Error("streamId already exists");

    if (purgeBeforeStart) {
      purgeResult = await purgeSourceArtifacts(streamId);
      log.info("source_purge_complete", {
        streamId,
        deletedEvents: purgeResult.deletedEvents,
        outDir: purgeResult.outDir
      });
    }

    setSourceState(streamId, {
      state: "starting",
      running: false,
      inputUrl,
      lastError: null
    });

    log.info("source_create_start", {
      streamId,
      inputUrl,
      mode,
      dvrSeconds,
      hlsSegmentSeconds: effectiveSegmentSeconds,
      vttSegmentSeconds: effectiveSegmentSeconds,
      purgeBeforeStart
    });

    const outDir = path.join(RECORD_ROOT, streamId);
    fs.mkdirSync(outDir, { recursive: true });

    // 1) DVR recorder (LL-HLS fMP4) — provides PROGRAM-DATE-TIME timestamps
    hls = startHlsRecorder({
      streamId,
      inputUrl,
      outDir,
      dvrSeconds,
      hlsSegmentSeconds: effectiveSegmentSeconds,
      mode,
      requestId: req.requestId
    });
    setSourceState(streamId, { state: "starting", stage: "hls_started" });
    const playlistPath = path.join(outDir, "playlist.m3u8");

    // 2) Segmented WebVTT sidecar track (default 5s segments, configurable)
    vtt = new SegmentedVttWriter({
  outDir,
  segmentSeconds: effectiveSegmentSeconds,
  dvrSeconds,

  // Variable-rate VTT tuning
  maxCuesPerSecond: Number(maxCuesPerSecond) || 10,
  minCueDurSec: Number(minCueDurSec) || 0.10,
  maxCueDurSec: Number(maxCueDurSec) || 0.50
});

    // Keep subtitle window aligned to the current DVR window of the video playlist
    vttWindowTimer = setInterval(() => {
      const w = readHlsPdtWindowMs(playlistPath);
      if (!w) return;
      vtt.setWindow(w.firstMs, w.lastMs);
    }, 500);

    // Write master playlist referencing subtitles + video
    const masterPath = path.join(outDir, "master.m3u8");
    fs.writeFileSync(masterPath, `#EXTM3U
#EXT-X-VERSION:7

#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="meta",NAME="KLV",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en",URI="subtitles.m3u8"

#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.42e01f",SUBTITLES="meta"
playlist.m3u8
`);

    // 3) KLV ingest (PAT/PMT KLVA PID preferred, fallback scan)
    klv = await startKlvIngest({
      streamId,
      inputUrl,
      requestId: req.requestId,
      onDecoded: async (decoded) => {
        const normalized = normalizeDecodedTimestamp(decoded);
        await store.add(streamId, normalized.decoded);

        // Add to segmented VTT (for DVR overlay)
        vtt.addKlv({ klvUnixMs: normalized.klvUnixMs, payload: normalized.decoded });

        // Optional: live KLV WS channel
        wsBroadcastLive(streamId, normalized.decoded);

        setSourceState(streamId, {
          lastKlvMs: normalized.klvUnixMs,
          lastKlvIso: new Date(normalized.klvUnixMs).toISOString(),
          klvTimeSource: normalized.timeSource
        });
      }
    });
    setSourceState(streamId, { state: "starting", stage: "klv_started" });

    // 4) WebRTC ingest path
    await sfu.ensureIngest(streamId);
    createdInSfu = true;
    ingestProc = await startFfmpegRtpIngest({
      inputUrl,
      sfu,
      streamId,
      mode,
      requestId: req.requestId
    });
    setSourceState(streamId, { state: "starting", stage: "ingest_ready" });

    sources.set(streamId, {
      streamId, inputUrl, mode,
      dvrSeconds: Number(dvrSeconds) || 600,
      hlsSegmentSeconds: effectiveSegmentSeconds,
      vttSegmentSeconds: effectiveSegmentSeconds,
      maxCuesPerSecond: Number(maxCuesPerSecond) || 10,
      minCueDurSec: Number(minCueDurSec) || 0.10,
      maxCueDurSec: Number(maxCueDurSec) || 0.50,
      hls, klv, vtt, vttWindowTimer,
      webrtc: { ingestProc, producerId: ingestProc.producerId }
    });

    const onWorkerExit = (service, code, signal) => {
      if (!sources.has(streamId)) return;
      const hardDown = service === "hls_recorder";
      setSourceState(streamId, {
        state: hardDown ? "error" : "degraded",
        running: !hardDown,
        lastError: `${service} exited (code=${String(code)}, signal=${String(signal)})`
      });
    };
    hls.proc?.once("exit", (code, signal) => onWorkerExit("hls_recorder", code, signal));
    ingestProc.proc?.once("exit", (code, signal) => onWorkerExit("ffmpeg_rtp_ingest", code, signal));
    klv.input?.once("error", (err) => {
      if (!sources.has(streamId)) return;
      setSourceState(streamId, {
        state: "degraded",
        running: true,
        lastError: `klv_ingest error: ${String(err?.message || err)}`
      });
    });

    setSourceState(streamId, { state: "running", running: true, stage: null, lastError: null });

    log.info("source_create_success", { streamId, producerId: ingestProc.producerId });

    res.json({
      ok: true,
      streamId,
      hlsMasterUrl: `/hls/${streamId}/master.m3u8`,
      subtitlesUrl: `/hls/${streamId}/subtitles.m3u8`,
      webrtc: { producerId: ingestProc.producerId },
      purge: {
        enabled: !!purgeBeforeStart,
        deletedEvents: purgeResult?.deletedEvents ?? 0
      },
      state: getSourceRuntime(streamId)
    });
  } catch (e) {
    if (vttWindowTimer) clearInterval(vttWindowTimer);
    try { await vtt?.flushNow(); } catch {}
    await stopKlvIngest(klv);
    await stopHlsRecorder(hls);
    if (ingestProc) await stopFfmpegRtpIngest(ingestProc);
    if (createdInSfu && requestedStreamId) {
      try { await sfu.closeIngest(requestedStreamId); } catch {}
    }

    if (requestedStreamId) {
      sources.delete(requestedStreamId);
      setSourceState(requestedStreamId, {
        state: "error",
        running: false,
        stage: null,
        lastError: String(e?.message || e)
      });
    }

    log.error("source_create_error", { error: serializeError(e) });
    res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.delete("/sources/:streamId", async (req, res) => {
  const streamId = req.params.streamId;
  const s = sources.get(streamId);
  if (!s) return res.json({ ok: false, error: "not found" });

  log.info("source_delete_start", { streamId });
  setSourceState(streamId, { state: "stopping", running: false, stage: null });
  sources.delete(streamId);

  if (s.vttWindowTimer) clearInterval(s.vttWindowTimer);
  try { await s.vtt?.flushNow(); } catch {}

  await stopKlvIngest(s.klv);
  await stopHlsRecorder(s.hls);

  if (s.webrtc?.ingestProc) await stopFfmpegRtpIngest(s.webrtc.ingestProc);
  await sfu.closeIngest(streamId);

  setSourceState(streamId, { state: "stopped", running: false, stage: null, lastError: null });
  log.info("source_delete_success", { streamId });
  res.json({ ok: true });
});

// ---------- API: direct KLV query ----------
app.get("/streams/:streamId/klv", async (req, res) => {
  const streamId = req.params.streamId;
  const fromMs = Number(req.query.fromMs);
  const toMs = Number(req.query.toMs);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return res.status(400).json({ error: "fromMs and toMs required (ms since epoch)" });
  }
  const events = await store.query(streamId, fromMs, toMs);
  res.json({ streamId, fromMs, toMs, events });
});

// ---------- WebRTC signaling ----------
app.get("/webrtc/rtpCapabilities", (req, res) => {
  res.json(sfu.routerRtpCapabilities());
});

app.post("/webrtc/createTransport", async (req, res) => {
  try {
    const t = await sfu.createWebRtcTransport();
    res.json(t);
  } catch (e) {
    log.error("webrtc_create_transport_error", { error: serializeError(e) });
    res.status(500).json({ ok: false, error: "failed to create transport" });
  }
});

app.post("/webrtc/connectTransport", async (req, res) => {
  const { transportId, dtlsParameters } = req.body || {};
  try {
    await sfu.connectWebRtcTransport(transportId, dtlsParameters);
    res.json({ ok: true });
  } catch (e) {
    log.error("webrtc_connect_transport_error", { transportId, error: serializeError(e) });
    res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/webrtc/consume", async (req, res) => {
  const { streamId, transportId, rtpCapabilities } = req.body || {};
  try {
    const maxAttempts = 20;
    const waitMs = 250;
    let out = null;
    let lastError = null;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        out = await sfu.consume(streamId, transportId, rtpCapabilities);
        break;
      } catch (e) {
        lastError = e;
        if (String(e?.message || e) !== "producer not ready") throw e;
        if (i < maxAttempts - 1) await sleep(waitMs);
      }
    }

    if (!out) {
      log.warn("webrtc_consume_wait_timeout", { streamId, transportId, attempts: maxAttempts });
      return res.status(503).json({ ok: false, retryable: true, error: "producer not ready" });
    }

    res.json(out);
  } catch (e) {
    log.error("webrtc_consume_error", { streamId, transportId, error: serializeError(e) });
    res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- SPA fallback ----------
app.get("*", (req, res) => {
  res.sendFile(path.resolve("./public/index.html"));
});

server.listen(HTTP_PORT, () => {
  console.log(`[http] http://localhost:${HTTP_PORT}`);
  console.log(`[ui]   http://localhost:${HTTP_PORT}/`);
  console.log(`[ogc]  http://localhost:${HTTP_PORT}/ogc/collections`);
});
