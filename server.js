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

const HTTP_PORT = 8090;
const WS_PORT = 8081;

const RECORD_ROOT = path.resolve("./recordings");
const DB_DIR = path.resolve("./db");

fs.mkdirSync(RECORD_ROOT, { recursive: true });
fs.mkdirSync(DB_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: "1mb" }));
const server = http.createServer(app);

// ---------- Storage ----------
const store = new SqliteKlvStore({ dbPath: path.join(DB_DIR, "klv.sqlite") });
await store.init();
store.startRetentionJob({ maxAgeMs: 2 * 60 * 60 * 1000 }); // keep 2h (demo)

// ---------- WebRTC SFU ----------
const sfu = await createWebRtcSfu({
  announcedIp: null,      // set if behind NAT
  rtcMinPort: 40000,
  rtcMaxPort: 49999
});

// ---------- Sources ----------
/**
 * sources map entry:
 * {
 *   streamId, inputUrl, mode, dvrSeconds, vttSegmentSeconds,
 *   hls, klv,
 *   vtt, vttWindowTimer,
 *   webrtc: { ingestProc, producerId }
 * }
 */
const sources = new Map();

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
  ws._sub = { streamId: null, mode: "live" };
  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "subscribe") {
      ws._sub = { streamId: msg.streamId, mode: msg.mode || "live" };
      if (ws._sub.streamId) {
        const last = await store.latest(ws._sub.streamId);
        if (last) ws.send(JSON.stringify({ type: "st0601", streamId: ws._sub.streamId, ...last.data }));
      }
    }
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
    vttSegmentSeconds: s.vttSegmentSeconds,
    hlsMasterUrl: `/hls/${s.streamId}/master.m3u8`,
    webrtcReady: !!s.webrtc?.producerId
  }));
  res.json(list);
});

app.post("/sources", async (req, res) => {
  try {
    const {
  streamId,
  inputUrl,
  mode = "xcode-any",
  dvrSeconds = 600,
  vttSegmentSeconds = 5,

  // Variable-rate VTT tuning
  maxCuesPerSecond = 10,
  minCueDurSec = 0.10,
  maxCueDurSec = 0.50
} = req.body || {};

    if (!streamId || !inputUrl) throw new Error("streamId and inputUrl required");
    if (sources.has(streamId)) throw new Error("streamId already exists");

    const outDir = path.join(RECORD_ROOT, streamId);
    fs.mkdirSync(outDir, { recursive: true });

    // 1) DVR recorder (LL-HLS fMP4) — provides PROGRAM-DATE-TIME timestamps
    const hls = startHlsRecorder({ streamId, inputUrl, outDir, dvrSeconds, mode });
    const playlistPath = path.join(outDir, "playlist.m3u8");

    // 2) Segmented WebVTT sidecar track (default 5s segments, configurable)
    const vtt = new SegmentedVttWriter({
  outDir,
  segmentSeconds: Number(vttSegmentSeconds) || 5,
  dvrSeconds,

  // Variable-rate VTT tuning
  maxCuesPerSecond: Number(maxCuesPerSecond) || 10,
  minCueDurSec: Number(minCueDurSec) || 0.10,
  maxCueDurSec: Number(maxCueDurSec) || 0.50
});

    // Keep subtitle window aligned to the current DVR window of the video playlist
    const vttWindowTimer = setInterval(() => {
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
    const klv = await startKlvIngest({
      streamId,
      inputUrl,
      onDecoded: async (decoded) => {
        await store.add(streamId, decoded);

        const klvUnixMs = decoded.timestampUnixMicros
          ? Number(BigInt(decoded.timestampUnixMicros) / 1000n)
          : Date.now();

        // Add to segmented VTT (for DVR overlay)
        vtt.addKlv({ klvUnixMs, payload: decoded });

        // Optional: live KLV WS channel
        wsBroadcastLive(streamId, decoded);
      }
    });

    // 4) WebRTC ingest path
    await sfu.ensureIngest(streamId);
    const ingestProc = await startFfmpegRtpIngest({ inputUrl, sfu, streamId, mode });

    sources.set(streamId, {
      streamId, inputUrl, mode,
      dvrSeconds: Number(dvrSeconds) || 600,
      vttSegmentSeconds: Number(vttSegmentSeconds) || 5,
      maxCuesPerSecond: Number(maxCuesPerSecond) || 10,
      minCueDurSec: Number(minCueDurSec) || 0.10,
      maxCueDurSec: Number(maxCueDurSec) || 0.50,
      hls, klv, vtt, vttWindowTimer,
      webrtc: { ingestProc, producerId: ingestProc.producerId }
    });

    res.json({
      ok: true,
      streamId,
      hlsMasterUrl: `/hls/${streamId}/master.m3u8`,
      subtitlesUrl: `/hls/${streamId}/subtitles.m3u8`,
      webrtc: { producerId: ingestProc.producerId }
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.delete("/sources/:streamId", async (req, res) => {
  const streamId = req.params.streamId;
  const s = sources.get(streamId);
  if (!s) return res.json({ ok: false, error: "not found" });

  if (s.vttWindowTimer) clearInterval(s.vttWindowTimer);
  try { await s.vtt?.flushNow(); } catch {}

  await stopKlvIngest(s.klv);
  await stopHlsRecorder(s.hls);

  if (s.webrtc?.ingestProc) await stopFfmpegRtpIngest(s.webrtc.ingestProc);
  await sfu.closeIngest(streamId);

  sources.delete(streamId);
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
  const t = await sfu.createWebRtcTransport();
  res.json(t);
});

app.post("/webrtc/connectTransport", async (req, res) => {
  const { transportId, dtlsParameters } = req.body || {};
  await sfu.connectWebRtcTransport(transportId, dtlsParameters);
  res.json({ ok: true });
});

app.post("/webrtc/consume", async (req, res) => {
  const { streamId, transportId, rtpCapabilities } = req.body || {};
  const out = await sfu.consume(streamId, transportId, rtpCapabilities);
  res.json(out);
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
