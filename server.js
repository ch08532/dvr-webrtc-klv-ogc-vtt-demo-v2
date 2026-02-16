import express from "express";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";

import { startHlsRecorder, stopHlsRecorder } from "./src/hls_recorder.js";
import { startKlvStreamWorker, stopKlvStreamWorker } from "./src/klv_stream_worker_client.js";
import { startSfuWorkerClient } from "./src/sfu_worker_client.js";
import { SqliteKlvStore } from "./src/storage/sqlite_klv_store.js";
import { registerOgcMovingFeaturesRoutes } from "./src/ogc_moving_features.js";
import { getRuntimeMetricsSnapshot } from "./src/runtime_metrics.js";
import {
  createServiceLogger,
  newRequestId,
  runWithLogContext,
  serializeError
} from "./src/service_logger.js";

const REQUESTED_HTTP_PORT = Number(process.env.HTTP_PORT || 8090);
const HTTP_PORT_EXPLICIT = process.env.HTTP_PORT != null;
const HTTP_PORT_SCAN_RANGE = Math.max(0, Number(process.env.HTTP_PORT_SCAN_RANGE || 20));
const WS_PATH = process.env.WS_PATH || "/ws";
const WEBRTC_ANNOUNCED_IP = process.env.WEBRTC_ANNOUNCED_IP || "127.0.0.1";
const FFPROBE_BIN = process.env.FFPROBE_BIN || "ffprobe";
const INPUT_PROBE_TIMEOUT_MS = Math.max(1000, Number(process.env.INPUT_PROBE_TIMEOUT_MS || 7000));
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
let httpPort = REQUESTED_HTTP_PORT;

// ---------- Storage ----------
const store = new SqliteKlvStore({ dbPath: path.join(DB_DIR, "klv.sqlite") });
await store.init();
store.startRetentionJob({ maxAgeMs: 2 * 60 * 60 * 1000 }); // keep 2h (demo)

// ---------- Sources ----------
/**
 * sources map entry:
 * {
 *   streamId, inputUrl, mode, dvrSeconds, vttSegmentSeconds,
 *   hlsSegmentSeconds,
 *   hls, klvWorker,
 *   webrtc: { ingestRunning, producerId }
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

function parseFrameRate(rateText) {
  if (!rateText || typeof rateText !== "string") return null;
  const [numText, denText] = rateText.split("/");
  const num = Number(numText);
  const den = Number(denText);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const value = num / den;
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(3));
}

function normalizeProbePayload(ffprobeJson, inputUrl) {
  const format = ffprobeJson && typeof ffprobeJson === "object" ? ffprobeJson.format : null;
  const streams = Array.isArray(ffprobeJson?.streams) ? ffprobeJson.streams : [];
  const firstVideo = streams.find((s) => s && s.codec_type === "video") || null;
  const dataStreams = streams.filter((s) => s && s.codec_type === "data");
  const explicitKlvStreams = dataStreams.filter((s) => {
    const text = [
      s.codec_name,
      s.codec_long_name,
      s.codec_tag_string,
      s.codec_tag,
      s.profile,
      s?.tags ? JSON.stringify(s.tags) : null
    ].filter(Boolean).join(" ").toLowerCase();
    return text.includes("klv")
      || text.includes("misb")
      || text.includes("smpte 336")
      || text.includes("st 336");
  });
  const fps = firstVideo ? (parseFrameRate(firstVideo.avg_frame_rate) ?? parseFrameRate(firstVideo.r_frame_rate)) : null;

  const container = format ? {
    name: format.format_name || null,
    longName: format.format_long_name || null
  } : null;

  const video = firstVideo ? {
    codec: firstVideo.codec_name || null,
    codecLongName: firstVideo.codec_long_name || null,
    width: Number.isFinite(Number(firstVideo.width)) ? Number(firstVideo.width) : null,
    height: Number.isFinite(Number(firstVideo.height)) ? Number(firstVideo.height) : null,
    fps
  } : null;

  const klvCandidates = explicitKlvStreams.length ? explicitKlvStreams : dataStreams;
  const klv = {
    available: klvCandidates.length > 0,
    confidence: explicitKlvStreams.length ? "high" : (dataStreams.length ? "possible" : "none"),
    streamCount: klvCandidates.length,
    streams: klvCandidates.slice(0, 3).map((s) => ({
      index: Number.isFinite(Number(s.index)) ? Number(s.index) : null,
      codec: s.codec_name || null,
      codecLongName: s.codec_long_name || null,
      codecTag: s.codec_tag_string || null
    }))
  };

  return {
    inputUrl,
    hasVideo: !!firstVideo,
    container,
    video,
    klv,
    streamCount: streams.length
  };
}

async function probeInputWithFfprobe(inputUrl, { timeoutMs = INPUT_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      "-show_entries", "format=format_name,format_long_name:stream=index,codec_type,codec_name,codec_long_name,codec_tag_string,codec_tag,width,height,avg_frame_rate,r_frame_rate,profile:stream_tags",
      "-analyzeduration", "3000000",
      "-probesize", "5000000",
      "-read_intervals", "%+3",
      inputUrl
    ];

    const proc = spawn(FFPROBE_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let finished = false;

    const finish = (err, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      finish(new Error(`ffprobe timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on("data", (buf) => {
      stdout += buf.toString();
    });

    proc.stderr.on("data", (buf) => {
      stderr += buf.toString();
    });

    proc.on("error", (error) => {
      finish(error);
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        const msg = stderr.trim() || `ffprobe exited with code ${String(code)}`;
        finish(new Error(msg));
        return;
      }
      try {
        const parsed = stdout.trim() ? JSON.parse(stdout) : {};
        finish(null, normalizeProbePayload(parsed, inputUrl));
      } catch (error) {
        finish(new Error(`ffprobe returned invalid JSON: ${String(error?.message || error)}`));
      }
    });
  });
}

async function bootstrapSubtitleArtifacts(outDir, segmentSeconds) {
  const segSec = normalizeSegmentSeconds(segmentSeconds, 1);
  const segMs = Math.max(1, Math.round(segSec * 1000));
  const nowMs = Date.now();
  const segNo = Math.floor(nowMs / segMs);
  const segStartMs = segNo * segMs;
  const segFile = `meta_${segNo}.vtt`;

  const subtitlePlaylistPath = path.join(outDir, "subtitles.m3u8");
  const segPath = path.join(outDir, segFile);

  const targetDuration = Math.max(1, Math.ceil(segSec));
  const playlist = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:${targetDuration}
#EXT-X-MEDIA-SEQUENCE:${segNo}
#EXT-X-PROGRAM-DATE-TIME:${new Date(segStartMs).toISOString()}
#EXTINF:${segSec.toFixed(3)},
${segFile}
`;

  await fs.promises.writeFile(segPath, "WEBVTT\n\n");
  await fs.promises.writeFile(subtitlePlaylistPath, playlist);
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

function currentSourceState(streamId) {
  const tracked = sourceStates.get(streamId);
  if (tracked?.state) return tracked.state;
  if (sources.has(streamId)) return "running";
  return "stopped";
}

async function purgeSourceArtifacts(streamId) {
  const outDir = path.join(RECORD_ROOT, streamId);
  const sdpFile = path.join(DB_DIR, `${streamId}.sdp`);

  try { await fs.promises.rm(outDir, { recursive: true, force: true }); } catch {}
  await fs.promises.mkdir(outDir, { recursive: true });
  try { await fs.promises.rm(sdpFile, { force: true }); } catch {}

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
  const klvRunning = isProcessRunning(source.klvWorker?.proc);
  const ingestRunning = !!source.webrtc?.ingestRunning;
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

// ---------- SFU worker ----------
const sfuClient = await startSfuWorkerClient({
  config: {
    announcedIp: WEBRTC_ANNOUNCED_IP,
    rtcMinPort: 40000,
    rtcMaxPort: 49999
  },
  onEvent: (event) => {
    if (event?.type !== "event") return;
    if (event.event !== "ingest_exit") return;
    if (!event.streamId) return;

    const source = sources.get(event.streamId);
    if (!source) return;
    if (source.webrtc) {
      source.webrtc.ingestRunning = false;
      source.webrtc.producerId = null;
    }

    if (event.intentional) return;
    setSourceState(event.streamId, {
      state: "degraded",
      running: true,
      ingestRunning: false,
      lastError: `sfu_ingest exited (code=${String(event.code)}, signal=${String(event.signal)})`
    });
  }
});

// ---------- WebSocket for LIVE KLV (optional) ----------
const wss = new WebSocketServer({ server, path: WS_PATH });
wss.on("error", (error) => {
  log.error("ws_server_error", { error: serializeError(error) });
});

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
// Prevent SPA fallback from returning index.html for missing HLS artifacts.
app.use("/hls", (_req, res) => {
  res.status(404).type("text/plain").send("hls artifact not found");
});

// ---------- OGC Moving Features subset ----------
registerOgcMovingFeaturesRoutes(app, { sources, store });

// ---------- API: input probe ----------
app.post("/probe/input", async (req, res) => {
  const inputUrl = typeof req.body?.inputUrl === "string" ? req.body.inputUrl.trim() : "";
  if (!inputUrl) {
    return res.status(400).json({ ok: false, error: "inputUrl required" });
  }

  try {
    const probe = await probeInputWithFfprobe(inputUrl);
    const available = probe.hasVideo;
    log.info("input_probe_result", {
      inputUrl,
      available,
      klvAvailable: !!probe.klv?.available,
      klvConfidence: probe.klv?.confidence || "none",
      container: probe.container?.name || null,
      codec: probe.video?.codec || null,
      width: probe.video?.width ?? null,
      height: probe.video?.height ?? null,
      fps: probe.video?.fps ?? null
    });

    return res.json({
      ok: true,
      available,
      indicator: available ? "green" : "red",
      reason: available ? "video_stream_found" : "video_stream_not_found",
      inputUrl: probe.inputUrl,
      container: probe.container,
      video: probe.video,
      klv: probe.klv,
      streamCount: probe.streamCount,
      testedAt: new Date().toISOString()
    });
  } catch (error) {
    const message = String(error?.message || error);
    log.warn("input_probe_error", { inputUrl, error: serializeError(error) });
    return res.json({
      ok: true,
      available: false,
      indicator: "red",
      reason: "probe_failed",
      inputUrl,
      error: message,
      klv: {
        available: false,
        confidence: "none",
        streamCount: 0,
        streams: []
      },
      testedAt: new Date().toISOString()
    });
  }
});

// ---------- API: sources ----------
app.get("/sources", (req, res) => {
  const list = [...sources.values()].map((s) => ({
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

  for (const [streamId, tracked] of sourceStates.entries()) {
    if (sources.has(streamId)) continue;
    if (tracked?.state !== "starting" && tracked?.state !== "stopping") continue;
    list.push({
      streamId,
      inputUrl: tracked?.inputUrl || null,
      mode: tracked?.mode || null,
      dvrSeconds: tracked?.dvrSeconds || null,
      hlsSegmentSeconds: tracked?.hlsSegmentSeconds || null,
      vttSegmentSeconds: tracked?.vttSegmentSeconds || null,
      hlsMasterUrl: `/hls/${streamId}/master.m3u8`,
      webrtcReady: false,
      ...getSourceRuntime(streamId)
    });
  }
  res.json(list);
});

app.get("/sources/:streamId/state", (req, res) => {
  res.json(getSourceRuntime(req.params.streamId));
});

app.post("/sources", async (req, res) => {
  let requestedStreamId = null;
  let hls = null;
  let klvWorker = null;
  let startedSfuIngest = false;
  let producerId = null;
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
    if (sources.has(streamId)) {
      return res.status(409).json({
        ok: false,
        error: `source ${streamId} already exists`,
        state: getSourceRuntime(streamId)
      });
    }
    const currentState = currentSourceState(streamId);
    if (currentState === "starting" || currentState === "running" || currentState === "degraded" || currentState === "stopping") {
      return res.status(409).json({
        ok: false,
        error: `source ${streamId} is currently ${currentState}; start is not allowed`,
        state: getSourceRuntime(streamId)
      });
    }

    setSourceState(streamId, {
      state: "starting",
      running: false,
      ingestRunning: false,
      inputUrl,
      stage: "initializing",
      lastError: null
    });

    if (purgeBeforeStart) {
      setSourceState(streamId, { state: "starting", stage: "purging" });
      purgeResult = await purgeSourceArtifacts(streamId);
      log.info("source_purge_complete", {
        streamId,
        deletedEvents: purgeResult.deletedEvents,
        outDir: purgeResult.outDir
      });
    }

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
    await fs.promises.mkdir(outDir, { recursive: true });

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

    // Write master playlist referencing subtitles + video
    const masterPath = path.join(outDir, "master.m3u8");
    await bootstrapSubtitleArtifacts(outDir, effectiveSegmentSeconds);
    await fs.promises.writeFile(masterPath, `#EXTM3U
#EXT-X-VERSION:7

#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="meta",NAME="KLV",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en",URI="subtitles.m3u8"

#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.42e01f",SUBTITLES="meta"
playlist.m3u8
`);

    // 2) KLV ingest + DB/VTT sidecar in dedicated worker process
    klvWorker = await startKlvStreamWorker({
      streamId,
      inputUrl,
      outDir,
      dvrSeconds: Number(dvrSeconds) || 600,
      segmentSeconds: effectiveSegmentSeconds,
      maxCuesPerSecond: Number(maxCuesPerSecond) || 10,
      minCueDurSec: Number(minCueDurSec) || 0.10,
      maxCueDurSec: Number(maxCueDurSec) || 0.50,
      dbPath: path.join(DB_DIR, "klv.sqlite"),
      requestId: req.requestId,
      onDecoded: ({ decoded, klvUnixMs, timeSource }) => {
        wsBroadcastLive(streamId, decoded);
        setSourceState(streamId, {
          lastKlvMs: klvUnixMs,
          lastKlvIso: new Date(klvUnixMs).toISOString(),
          klvTimeSource: timeSource
        });
      },
      onError: (error) => {
        if (!sources.has(streamId)) return;
        setSourceState(streamId, {
          state: "degraded",
          running: true,
          lastError: `klv_worker error: ${String(error?.message || error)}`
        });
      }
    });
    setSourceState(streamId, { state: "starting", stage: "klv_started" });

    // 3) WebRTC ingest path (delegated to SFU worker process)
    const ingest = await sfuClient.startIngest({
      streamId,
      inputUrl,
      mode,
      requestId: req.requestId
    });
    startedSfuIngest = true;
    producerId = ingest.producerId;
    setSourceState(streamId, {
      state: "starting",
      stage: "ingest_ready",
      ingestRunning: true
    });

    sources.set(streamId, {
      streamId, inputUrl, mode,
      dvrSeconds: Number(dvrSeconds) || 600,
      hlsSegmentSeconds: effectiveSegmentSeconds,
      vttSegmentSeconds: effectiveSegmentSeconds,
      maxCuesPerSecond: Number(maxCuesPerSecond) || 10,
      minCueDurSec: Number(minCueDurSec) || 0.10,
      maxCueDurSec: Number(maxCueDurSec) || 0.50,
      hls, klvWorker,
      webrtc: { ingestRunning: true, producerId }
    });

    const onWorkerExit = (service, code, signal) => {
      if (!sources.has(streamId)) return;
      const currentState = currentSourceState(streamId);
      if (currentState === "stopping" || currentState === "stopped") return;
      const hardDown = service === "hls_recorder";
      setSourceState(streamId, {
        state: hardDown ? "error" : "degraded",
        running: !hardDown,
        lastError: `${service} exited (code=${String(code)}, signal=${String(signal)})`
      });
    };
    hls.proc?.once("exit", (code, signal) => onWorkerExit("hls_recorder", code, signal));
    klvWorker.proc?.once("exit", (code, signal) => onWorkerExit("klv_worker", code, signal));

    setSourceState(streamId, {
      state: "running",
      running: true,
      stage: null,
      ingestRunning: true,
      lastError: null
    });

    log.info("source_create_success", { streamId, producerId });

    res.json({
      ok: true,
      streamId,
      hlsMasterUrl: `/hls/${streamId}/master.m3u8`,
      subtitlesUrl: `/hls/${streamId}/subtitles.m3u8`,
      webrtc: { producerId },
      purge: {
        enabled: !!purgeBeforeStart,
        deletedEvents: purgeResult?.deletedEvents ?? 0
      },
      state: getSourceRuntime(streamId)
    });
  } catch (e) {
    if (klvWorker) await stopKlvStreamWorker(klvWorker);
    await stopHlsRecorder(hls);
    if (startedSfuIngest && requestedStreamId) {
      try { await sfuClient.stopIngest(requestedStreamId); } catch {}
    }

    if (requestedStreamId) {
      sources.delete(requestedStreamId);
      setSourceState(requestedStreamId, {
        state: "error",
        running: false,
        ingestRunning: false,
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
  const state = currentSourceState(streamId);
  if (state === "starting" || state === "stopping") {
    return res.status(409).json({
      ok: false,
      error: `source ${streamId} is currently ${state}; stop is not allowed`,
      state: getSourceRuntime(streamId)
    });
  }
  const s = sources.get(streamId);
  if (!s) return res.status(404).json({ ok: false, error: "not found", state: getSourceRuntime(streamId) });

  log.info("source_delete_start", { streamId });
  setSourceState(streamId, { state: "stopping", running: false, ingestRunning: false, stage: "teardown" });
  sources.delete(streamId);

  await stopKlvStreamWorker(s.klvWorker);
  await stopHlsRecorder(s.hls);
  await sfuClient.stopIngest(streamId);

  setSourceState(streamId, { state: "stopped", running: false, ingestRunning: false, stage: null, lastError: null });
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
app.get("/webrtc/rtpCapabilities", async (req, res) => {
  try {
    const caps = await sfuClient.routerRtpCapabilities();
    res.json(caps);
  } catch (e) {
    log.error("webrtc_rtp_capabilities_error", { error: serializeError(e) });
    res.status(500).json({ ok: false, error: "failed to fetch rtp capabilities" });
  }
});

app.post("/webrtc/createTransport", async (req, res) => {
  try {
    const t = await sfuClient.createWebRtcTransport();
    res.json(t);
  } catch (e) {
    log.error("webrtc_create_transport_error", { error: serializeError(e) });
    res.status(500).json({ ok: false, error: "failed to create transport" });
  }
});

app.post("/webrtc/connectTransport", async (req, res) => {
  const { transportId, dtlsParameters } = req.body || {};
  try {
    await sfuClient.connectWebRtcTransport(transportId, dtlsParameters);
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
        out = await sfuClient.consume(streamId, transportId, rtpCapabilities);
        break;
      } catch (e) {
        lastError = e;
        if (String(e?.message || e) !== "producer not ready") throw e;
        if (i < maxAttempts - 1) await sleep(waitMs);
      }
    }

    if (!out) {
      log.warn("webrtc_consume_wait_timeout", {
        streamId,
        transportId,
        attempts: maxAttempts,
        lastError: String(lastError?.message || lastError || "")
      });
      return res.status(503).json({ ok: false, retryable: true, error: "producer not ready" });
    }

    res.json(out);
  } catch (e) {
    log.error("webrtc_consume_error", { streamId, transportId, error: serializeError(e) });
    res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/webrtc/debug", async (req, res) => {
  try {
    const snapshot = await sfuClient.debugSnapshot();
    res.json({
      ok: true,
      timestampIso: new Date().toISOString(),
      snapshot
    });
  } catch (e) {
    log.error("webrtc_debug_error", { error: serializeError(e) });
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- Runtime metrics / health ----------
app.get("/metrics/runtime", async (req, res) => {
  const runtime = getRuntimeMetricsSnapshot();
  let sfuHealth = null;
  let sfuError = null;
  try {
    sfuHealth = await sfuClient.health();
  } catch (e) {
    sfuError = String(e?.message || e);
  }

  const klvWorkers = [...sources.values()].map((s) => ({
    streamId: s.streamId,
    pid: s.klvWorker?.proc?.pid ?? null,
    connected: !!s.klvWorker?.proc?.connected,
    running: isProcessRunning(s.klvWorker?.proc),
    exitCode: s.klvWorker?.proc?.exitCode ?? null
  }));

  res.json({
    ...runtime,
    server: {
      httpPort,
      wsPath: WS_PATH,
      activeSources: sources.size,
      statesTracked: sourceStates.size
    },
    workers: {
      sfu: sfuError ? { ok: false, error: sfuError } : { ok: true, ...sfuHealth },
      klv: klvWorkers
    }
  });
});

app.get("/healthz", async (req, res) => {
  const runtime = getRuntimeMetricsSnapshot();
  const degradedOrError = [...sourceStates.values()]
    .filter((s) => s.state === "degraded" || s.state === "error")
    .length;

  let sfuOk = true;
  let sfuInfo = null;
  let sfuError = null;
  try {
    sfuInfo = await sfuClient.health();
  } catch (e) {
    sfuOk = false;
    sfuError = String(e?.message || e);
  }

  const ok = sfuOk;
  res.status(ok ? 200 : 503).json({
    ok,
    timestampIso: new Date().toISOString(),
    activeSources: sources.size,
    degradedOrErrorSources: degradedOrError,
    eventLoopLagP99Ms: runtime.process.eventLoopLagMs.p99,
    sfu: sfuOk ? {
      ok: true,
      pid: sfuInfo?.pid ?? null,
      ingestCount: sfuInfo?.ingestCount ?? 0
    } : {
      ok: false,
      error: sfuError
    }
  });
});

// ---------- SPA fallback ----------
app.get("*", (req, res) => {
  res.sendFile(path.resolve("./public/index.html"));
});

async function isPortAvailable(port) {
  return await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port);
  });
}

async function chooseHttpPort() {
  if (HTTP_PORT_EXPLICIT) return REQUESTED_HTTP_PORT;

  for (let p = REQUESTED_HTTP_PORT; p <= REQUESTED_HTTP_PORT + HTTP_PORT_SCAN_RANGE; p++) {
    if (await isPortAvailable(p)) return p;
  }

  throw new Error(
    `No available HTTP port in range ${REQUESTED_HTTP_PORT}-${REQUESTED_HTTP_PORT + HTTP_PORT_SCAN_RANGE}`
  );
}

const selectedPort = await chooseHttpPort();
if (selectedPort !== REQUESTED_HTTP_PORT) {
  log.warn("http_port_auto_selected", {
    requestedPort: REQUESTED_HTTP_PORT,
    selectedPort
  });
}
httpPort = selectedPort;

server.on("error", (error) => {
  log.error("http_server_error", { error: serializeError(error), port: httpPort });
  process.exit(1);
});

server.listen(httpPort, () => {
  console.log(`[http] http://localhost:${httpPort}`);
  console.log(`[ui]   http://localhost:${httpPort}/`);
  console.log(`[ws]   ws://localhost:${httpPort}${WS_PATH}`);
  console.log(`[ogc]  http://localhost:${httpPort}/ogc/collections`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutdown_start", { signal });

  const entries = [...sources.entries()];
  for (const [streamId, s] of entries) {
    sources.delete(streamId);
    try { await stopKlvStreamWorker(s.klvWorker); } catch {}
    try { await stopHlsRecorder(s.hls); } catch {}
    try { await sfuClient.stopIngest(streamId); } catch {}
  }

  try { await sfuClient.close(); } catch {}
  try { await store.close(); } catch {}
  try { wss.close(); } catch {}
  try {
    await new Promise((resolve) => server.close(() => resolve()));
  } catch {}

  process.exit(0);
}

process.on("SIGINT", () => { shutdown("SIGINT").catch(() => process.exit(1)); });
process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(1)); });
