/** Main service: source lifecycle, media pipelines, APIs, WebSockets, and shutdown. */
import express from "express";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { WebSocketServer } from "ws";

import { startHlsRecorder, stopHlsRecorder } from "./src/hls_recorder.js";
import { createHlsMasterPlaylist, createPassthroughHlsMasterPlaylist } from "./src/hls_ladder.js";
import { finalizeKlvStreamWorker, startKlvStreamWorker, stopKlvStreamWorker } from "./src/klv_stream_worker_client.js";
import { startSfuWorkerClient } from "./src/sfu_worker_client.js";
import { SqliteKlvStore } from "./src/storage/sqlite_klv_store.js";
import { registerOgcMovingFeaturesRoutes } from "./src/ogc_moving_features.js";
import { getRuntimeMetricsSnapshot } from "./src/runtime_metrics.js";
import { getGpuMetrics } from "./src/gpu_metrics.js";
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
const LIVE_DIMENSION_PROBE_TIMEOUT_MS = Math.max(INPUT_PROBE_TIMEOUT_MS, Number(process.env.LIVE_DIMENSION_PROBE_TIMEOUT_MS || 15000));
const SHUTDOWN_FORCE_EXIT_MS = Math.max(1000, Number(process.env.SHUTDOWN_FORCE_EXIT_MS || 10000));
const log = createServiceLogger("server");

const RECORD_ROOT = path.resolve("./recordings");
const DB_DIR = path.resolve("./db");
const VIDEO_ROOT = path.resolve("./videos");
const MAX_UPLOAD_BYTES = Math.max(1, Number(process.env.MAX_VIDEO_UPLOAD_MB || 10_240)) * 1024 * 1024;
const VIDEO_UPLOAD_EXTENSIONS = new Set([".ts", ".m2ts", ".mp4", ".mov", ".mkv"]);
const CLIP_MIN_DURATION_SECONDS = 0.25;
// Leave clip duration unrestricted by default. Deployments that need a policy
// limit can set MAX_CLIP_DURATION_SECONDS to a positive number.
const CLIP_MAX_DURATION_SECONDS = Number(process.env.MAX_CLIP_DURATION_SECONDS || 0);
const SOURCE_POSTER_WIDTH = Math.max(96, Math.min(320, Number(process.env.SOURCE_POSTER_WIDTH || 160)));
const SOURCE_POSTER_TIMEOUT_MS = Math.max(3000, Number(process.env.SOURCE_POSTER_TIMEOUT_MS || 15000));
const AUTHORITATIVE_SNAPSHOT_TIMEOUT_MS = Math.max(3000, Number(process.env.AUTHORITATIVE_SNAPSHOT_TIMEOUT_MS || 30000));
const KLV_FINALIZE_MIN_TIMEOUT_MS = Math.max(30000, Number(process.env.KLV_FINALIZE_MIN_TIMEOUT_MS || 30000));
const KLV_FINALIZE_MS_PER_SEGMENT = Math.max(50, Number(process.env.KLV_FINALIZE_MS_PER_SEGMENT || 500));
const KLV_FINALIZE_MAX_TIMEOUT_MS = Math.max(KLV_FINALIZE_MIN_TIMEOUT_MS, Number(process.env.KLV_FINALIZE_MAX_TIMEOUT_MS || 2 * 60 * 60 * 1000));

fs.mkdirSync(RECORD_ROOT, { recursive: true });
fs.mkdirSync(DB_DIR, { recursive: true });
fs.mkdirSync(VIDEO_ROOT, { recursive: true });

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
const httpSockets = new Set();
server.on("connection", (socket) => {
  httpSockets.add(socket);
  socket.on("close", () => httpSockets.delete(socket));
});

// ---------- Storage ----------
const store = new SqliteKlvStore({ dbPath: path.join(DB_DIR, "klv.sqlite") });
await store.init();
store.startRetentionJob({ maxAgeMs: 2 * 60 * 60 * 1000 }); // keep 2h (demo)

// ---------- Sources ----------
/**
 * sources map entry:
 * {
 *   streamId, inputUrl, mode, vttSegmentSeconds,
 *   hlsSegmentSeconds,
 *   hls, klvWorker,
 *   webrtc: { ingestRunning, producerId }
 * }
 */
const sources = new Map();
const sourceStates = new Map();

/** Tests whether a spawned child process is still active. */
function isProcessRunning(proc) {
  return !!proc && proc.exitCode == null && !proc.killed;
}

/** Returns a promise that resolves after a delay. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Validates a configured media segment duration. */
function normalizeSegmentSeconds(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/** Gives large file sources enough time to flush their remaining KLV/VTT segments. */
function estimateKlvFinalizeTimeoutMs(durationSeconds, segmentSeconds) {
  const duration = Number(durationSeconds);
  const segment = normalizeSegmentSeconds(segmentSeconds, 5);
  if (!Number.isFinite(duration) || duration <= 0) return KLV_FINALIZE_MIN_TIMEOUT_MS;
  const estimatedSegments = Math.max(1, Math.ceil(duration / segment));
  const estimatedMs = estimatedSegments * KLV_FINALIZE_MS_PER_SEGMENT;
  return Math.min(KLV_FINALIZE_MAX_TIMEOUT_MS, Math.max(KLV_FINALIZE_MIN_TIMEOUT_MS, estimatedMs));
}

/** Converts public source type input to stream or file. */
function normalizeSourceType(value) {
  return value === "file" ? "file" : "stream";
}

/** Converts public HLS mode input to passthrough or ABR. */
function normalizeHlsMode(value) {
  return value === "abr" ? "abr" : "passthrough";
}

/** Converts public WebRTC mode input to auto, copy, or transcode. */
function normalizeWebRtcMode(value) {
  if (value === "copy" || value === "transcode") return value;
  return "auto";
}

/** Chooses copy, single-transcode, or ABR HLS processing from input capabilities. */
function resolveHlsEncodeMode(hlsMode, probe) {
  // HLS passthrough is video-only: source audio is deliberately not part of
  // either HLS output, so its codec must not force a video transcode.
  if (hlsMode === "abr") {
    return { encoderMode: "xcode-any", effectiveMode: "abr", fallbackReason: null };
  }

  const videoCodec = String(probe?.video?.codec || "").toLowerCase();
  if (videoCodec === "h264") {
    return { encoderMode: "copy-h264", effectiveMode: "passthrough", fallbackReason: null };
  }

  return {
    encoderMode: "xcode-single",
    effectiveMode: "single-transcode",
    fallbackReason: `video codec ${videoCodec || "unknown"} is not browser-compatible for HLS passthrough`
  };
}

/** Chooses whether the live RTP path can copy H.264 or must transcode. */
function resolveWebRtcEncodeMode(webRtcMode, probe) {
  if (webRtcMode === "copy") return "copy-h264";
  if (webRtcMode === "transcode") return "xcode-any";
  return String(probe?.video?.codec || "").toLowerCase() === "h264"
    ? "copy-h264"
    : "xcode-any";
}

/** Validates and resolves a server-owned uploaded video asset path. */
function resolveUploadedVideo(assetId) {
  if (typeof assetId !== "string" || !/^[a-f0-9-]{36}\.(?:ts|m2ts|mp4|mov|mkv)$/i.test(assetId)) {
    throw new Error("invalid uploaded video asset ID");
  }
  const inputUrl = path.resolve(VIDEO_ROOT, assetId);
  if (!inputUrl.startsWith(`${VIDEO_ROOT}${path.sep}`) || !fs.existsSync(inputUrl)) {
    throw new Error("uploaded video file not found");
  }
  return inputUrl;
}

/** Parses an ffprobe frame-rate fraction into frames per second. */
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

/** Reduces ffprobe output to the codec, timing, KLV, and container fields the UI needs. */
function normalizeProbePayload(ffprobeJson, inputUrl) {
  const format = ffprobeJson && typeof ffprobeJson === "object" ? ffprobeJson.format : null;
  const streams = Array.isArray(ffprobeJson?.streams) ? ffprobeJson.streams : [];
  const firstVideo = streams.find((s) => s && s.codec_type === "video") || null;
  const firstAudio = streams.find((s) => s && s.codec_type === "audio") || null;
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
    longName: format.format_long_name || null,
    durationSeconds: Number.isFinite(Number(format.duration)) ? Number(format.duration) : null
  } : null;

  const video = firstVideo ? {
    codec: firstVideo.codec_name || null,
    codecLongName: firstVideo.codec_long_name || null,
    profile: firstVideo.profile || null,
    width: Number.isFinite(Number(firstVideo.width)) ? Number(firstVideo.width) : null,
    height: Number.isFinite(Number(firstVideo.height)) ? Number(firstVideo.height) : null,
    sampleAspectRatio: firstVideo.sample_aspect_ratio || null,
    displayAspectRatio: firstVideo.display_aspect_ratio || null,
    fps
  } : null;
  const audio = firstAudio ? {
    codec: firstAudio.codec_name || null,
    codecLongName: firstAudio.codec_long_name || null
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
    durationSeconds: container?.durationSeconds ?? null,
    video,
    audio,
    klv,
    streamCount: streams.length
  };
}

/** Runs ffprobe with bounded analysis and returns a normalized source-media description. */
async function probeInputWithFfprobe(inputUrl, {
  timeoutMs = INPUT_PROBE_TIMEOUT_MS,
  analyzeDurationUs = 3_000_000,
  probeSizeBytes = 5_000_000,
  readInterval = "%+3"
} = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      "-show_entries", "format=format_name,format_long_name,duration:stream=index,codec_type,codec_name,codec_long_name,codec_tag_string,codec_tag,width,height,sample_aspect_ratio,display_aspect_ratio,avg_frame_rate,r_frame_rate,profile:stream_tags",
      "-analyzeduration", String(analyzeDurationUs),
      "-probesize", String(probeSizeBytes),
      ...(readInterval ? ["-read_intervals", readInterval] : []),
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

/** Returns whether a probe has a usable source frame size for HLS ladder selection. */
function hasVideoDimensions(probe) {
  return Number.isInteger(probe?.video?.width)
    && probe.video.width > 0
    && Number.isInteger(probe?.video?.height)
    && probe.video.height > 0;
}

/** Merges a follow-up live probe without discarding earlier KLV/audio information. */
function mergeLiveProbe(initialProbe, dimensionProbe) {
  return {
    ...initialProbe,
    ...dimensionProbe,
    video: { ...initialProbe?.video, ...dimensionProbe?.video },
    audio: dimensionProbe?.audio || initialProbe?.audio || null,
    klv: initialProbe?.klv?.available ? initialProbe.klv : (dimensionProbe?.klv || initialProbe?.klv || null)
  };
}

/** Runs FFmpeg and includes its useful error text when a media job fails. */
async function runFfmpeg(args, { label = "FFmpeg job", timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let finished = false;
    const finish = (error = null) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = timeoutMs > 0 ? setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      finish(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs) : null;
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 12_000) stderr = stderr.slice(-12_000);
    });
    proc.on("error", (error) => finish(error));
    proc.on("close", (code, signal) => {
      if (code === 0) return finish();
      const detail = stderr.trim() || `ffmpeg exited with code ${String(code)}`;
      finish(new Error(`${label} failed${signal ? ` (${signal})` : ""}: ${detail}`));
    });
  });
}

/** Validates a requested source-media time range against a file source. */
function normalizeClipRange({ startSeconds, endSeconds, durationSeconds = null }) {
  const start = Number(startSeconds);
  const end = Number(endSeconds);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new Error("clip start and end must be valid times with end after start");
  }
  const duration = end - start;
  if (duration < CLIP_MIN_DURATION_SECONDS) {
    throw new Error(`clip must be at least ${CLIP_MIN_DURATION_SECONDS}s long`);
  }
  if (Number.isFinite(CLIP_MAX_DURATION_SECONDS) && CLIP_MAX_DURATION_SECONDS > 0 && duration > CLIP_MAX_DURATION_SECONDS) {
    throw new Error(`clip must be no longer than ${CLIP_MAX_DURATION_SECONDS}s`);
  }
  if (Number.isFinite(durationSeconds) && end > durationSeconds + 0.05) {
    throw new Error("clip end is outside the uploaded video duration");
  }
  return {
    start: Number(start.toFixed(3)),
    end: Number(end.toFixed(3)),
    duration: Number(duration.toFixed(3))
  };
}

// Some MPEG-TS files (including MX15 recordings) have valid media timestamps
// but no container duration.  FFprobe consequently reports Duration: N/A,
// which is insufficient for a file-conversion progress bar.  Estimate the
// duration from the first and last PCR values without decoding the file.
/** Estimates a transport-stream file duration from PCR timestamps when needed. */
async function probeMpegTsDurationFromPcr(inputUrl) {
  if (!/\.(?:ts|m2ts)$/i.test(String(inputUrl || ""))) return null;

  let handle = null;
  try {
    const stat = await fs.promises.stat(inputUrl);
    if (!stat.isFile() || stat.size < 188 * 3) return null;

    handle = await fs.promises.open(inputUrl, "r");
    const probeBytes = Math.min(stat.size, 64 * 1024);
    const probe = Buffer.allocUnsafe(probeBytes);
    const { bytesRead: probeRead } = await handle.read(probe, 0, probe.length, 0);

    let packetSize = 0;
    let firstPacketOffset = 0;
    for (const candidateSize of [188, 192]) {
      const maxOffset = Math.min(candidateSize, probeRead - (candidateSize * 3));
      for (let offset = 0; offset <= maxOffset; offset += 1) {
        if (probe[offset] === 0x47
          && probe[offset + candidateSize] === 0x47
          && probe[offset + (candidateSize * 2)] === 0x47) {
          packetSize = candidateSize;
          firstPacketOffset = offset;
          break;
        }
      }
      if (packetSize) break;
    }
    if (!packetSize) return null;

    const packetsPerRead = 4096;
    const buffer = Buffer.allocUnsafe(packetSize * packetsPerRead);
    let position = firstPacketOffset;
    let firstPcr = null;
    let lastPcr = null;
    let invalidPackets = 0;

    while (position + packetSize <= stat.size) {
      const requested = Math.min(buffer.length, stat.size - position);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (!bytesRead) break;

      const packetBytes = Math.floor(bytesRead / packetSize) * packetSize;
      for (let offset = 0; offset < packetBytes; offset += packetSize) {
        if (buffer[offset] !== 0x47) {
          invalidPackets += 1;
          // A long invalid run means this is a padded/corrupt TS tail, not a
          // momentary damaged packet.  The last PCR before it is the end.
          if (invalidPackets >= 64) break;
          continue;
        }
        invalidPackets = 0;
        const adaptationControl = (buffer[offset + 3] >> 4) & 0x03;
        const adaptationLength = buffer[offset + 4];
        const hasPcr = (adaptationControl === 2 || adaptationControl === 3)
          && adaptationLength >= 7
          && (buffer[offset + 5] & 0x10) !== 0;
        if (!hasPcr) continue;

        const pcrOffset = offset + 6;
        const pcrBase = (buffer[pcrOffset] * (2 ** 25))
          + (buffer[pcrOffset + 1] * (2 ** 17))
          + (buffer[pcrOffset + 2] * (2 ** 9))
          + (buffer[pcrOffset + 3] * 2)
          + (buffer[pcrOffset + 4] >> 7);
        const pcrExtension = ((buffer[pcrOffset + 4] & 0x01) * 256) + buffer[pcrOffset + 5];
        const pcr = (pcrBase * 300) + pcrExtension;
        if (firstPcr == null) firstPcr = pcr;
        lastPcr = pcr;
      }
      if (invalidPackets >= 64 || bytesRead < requested) break;
      position += packetBytes;
    }

    if (firstPcr == null || lastPcr == null) return null;
    const pcrWrap = (2 ** 33) * 300;
    let elapsedPcr = lastPcr - firstPcr;
    if (elapsedPcr < 0) elapsedPcr += pcrWrap;
    const durationSeconds = elapsedPcr / 27_000_000;
    return Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Creates initial empty subtitle artifacts before KLV cues are available. */
async function bootstrapSubtitleArtifacts(outDir, segmentSeconds) {
  const segSec = normalizeSegmentSeconds(segmentSeconds, 1);
  const subtitlePlaylistPath = path.join(outDir, "subtitles.m3u8");

  const targetDuration = Math.max(1, Math.ceil(segSec));
  const playlist = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:${targetDuration}
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
`;
  await fs.promises.writeFile(subtitlePlaylistPath, playlist);
}

/** Merges a source lifecycle update and broadcasts it to subscribed clients. */
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

/** Returns the current public state object for a source. */
function currentSourceState(streamId) {
  const tracked = sourceStates.get(streamId);
  if (tracked?.state) return tracked.state;
  if (sources.has(streamId)) return "running";
  return "stopped";
}

/** Stops a source and deletes its generated media, KLV, and database artifacts. */
async function purgeSourceArtifacts(streamId) {
  const outDir = path.join(RECORD_ROOT, streamId);
  const sdpFile = path.join(DB_DIR, `${streamId}.sdp`);

  try { await fs.promises.rm(outDir, { recursive: true, force: true }); } catch {}
  await fs.promises.mkdir(outDir, { recursive: true });
  try { await fs.promises.rm(sdpFile, { force: true }); } catch {}

  const deletedEvents = await store.purgeStream(streamId);
  return { outDir, sdpFile, deletedEvents };
}

/** Returns the internal runtime handle for an active source, if any. */
function getSourceRuntime(streamId) {
  const tracked = sourceStates.get(streamId);
  const source = sources.get(streamId);

  if (!source) {
    return {
      streamId,
      state: tracked?.state || "stopped",
      running: false,
      sourceType: tracked?.sourceType || "stream",
      webRtcAvailable: tracked?.webRtcAvailable !== false,
      hlsMode: tracked?.hlsMode || null,
      hlsEffectiveMode: tracked?.hlsEffectiveMode || null,
      hlsFallbackReason: tracked?.hlsFallbackReason || null,
      webRtcMode: tracked?.webRtcMode || null,
      hlsEncoderMode: tracked?.hlsEncoderMode || null,
      webRtcEncoderMode: tracked?.webRtcEncoderMode || null,
      hlsRenditions: tracked?.hlsRenditions || null,
      copyNativeTopRung: tracked?.copyNativeTopRung === true,
      klvProbe: tracked?.klvProbe || null,
      sourceVideo: tracked?.sourceVideo || null,
      stage: tracked?.stage || null,
      durationSeconds: tracked?.durationSeconds ?? null,
      processedSeconds: tracked?.processedSeconds ?? null,
      progressPercent: tracked?.progressPercent ?? null,
      encodeSpeed: tracked?.encodeSpeed ?? null,
      etaSeconds: tracked?.etaSeconds ?? null,
      encoder: tracked?.encoder ?? null,
      usingGpu: tracked?.usingGpu ?? null,
      lastError: tracked?.lastError || null,
      updatedAt: tracked?.updatedAt || new Date().toISOString()
    };
  }

  const hlsRunning = isProcessRunning(source.hls?.proc);
  const klvRunning = isProcessRunning(source.klvWorker?.proc);
  const ingestRunning = !!source.webrtc?.ingestRunning;
  const running = hlsRunning;

  let state = tracked?.state || "running";
  if (state === "ready") {
    // A completed file source retains its HLS/VTT artifacts but no child processes.
  } else if (state === "starting" || state === "stopping" || state === "finalizing") {
    // honor explicit transition state
  } else if (hlsRunning && klvRunning && (source.sourceType === "file" || ingestRunning)) {
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
    sourceType: source.sourceType,
    webRtcAvailable: source.sourceType !== "file",
    hlsMode: source.hlsMode,
    hlsEffectiveMode: source.hlsEffectiveMode,
    hlsFallbackReason: source.hlsFallbackReason,
    webRtcMode: source.webRtcMode,
    hlsEncoderMode: source.hlsEncoderMode,
    webRtcEncoderMode: source.webRtcEncoderMode,
    hlsRenditions: source.hlsRenditions || tracked?.hlsRenditions || null,
    copyNativeTopRung: source.copyNativeTopRung === true,
    klvProbe: source.klvProbe || tracked?.klvProbe || null,
    sourceVideo: source.sourceVideo || tracked?.sourceVideo || null,
    stage: tracked?.stage || null,
    durationSeconds: tracked?.durationSeconds ?? null,
    processedSeconds: tracked?.processedSeconds ?? null,
    progressPercent: tracked?.progressPercent ?? null,
    encodeSpeed: tracked?.encodeSpeed ?? null,
    etaSeconds: tracked?.etaSeconds ?? null,
    encoder: source.hls?.encoder ?? tracked?.encoder ?? null,
    usingGpu: source.hls?.usingGpu ?? tracked?.usingGpu ?? null,
    hlsRunning,
    klvRunning,
    ingestRunning,
    lastError: tracked?.lastError || null,
    updatedAt: tracked?.updatedAt || new Date().toISOString()
  };
}

/** Captures one lightweight poster frame for the Active Sources list. */
async function generateSourcePoster(streamId) {
  const source = sources.get(streamId);
  if (!source || source.poster?.state === "generating" || source.poster?.state === "ready") return;

  const outDir = path.join(RECORD_ROOT, streamId);
  const posterPath = path.join(outDir, "poster.jpg");
  const durationSeconds = Number(sourceStates.get(streamId)?.durationSeconds);
  const captureSeconds = source.sourceType === "file" && Number.isFinite(durationSeconds) && durationSeconds > 0
    ? Math.min(5, Math.max(0, durationSeconds * 0.05))
    : null;
  source.poster = { state: "generating", updatedAt: new Date().toISOString(), error: null };

  try {
    await fs.promises.mkdir(outDir, { recursive: true });
    await runFfmpeg([
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      ...(captureSeconds != null ? ["-ss", String(Number(captureSeconds.toFixed(3)))] : []),
      "-i", source.inputUrl,
      "-frames:v", "1",
      "-vf", `scale=${SOURCE_POSTER_WIDTH}:-2`,
      "-q:v", "4",
      posterPath
    ], { label: "source poster capture", timeoutMs: SOURCE_POSTER_TIMEOUT_MS });

    if (sources.get(streamId) !== source) {
      await fs.promises.rm(posterPath, { force: true }).catch(() => {});
      return;
    }
    source.poster = { state: "ready", updatedAt: new Date().toISOString(), error: null };
    log.info("source_poster_ready", { streamId, captureSeconds });
  } catch (error) {
    if (sources.get(streamId) !== source) return;
    source.poster = { state: "error", updatedAt: new Date().toISOString(), error: String(error?.message || error) };
    log.warn("source_poster_error", { streamId, error: serializeError(error) });
  }
}

/** Queues poster capture without delaying HLS, KLV, or WebRTC start. */
function queueSourcePoster(streamId) {
  void generateSourcePoster(streamId);
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

/** Broadcasts one decoded live telemetry message to matching WebSocket clients. */
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
app.post("/uploads/video", async (req, res) => {
  const uploadName = decodeURIComponent(String(req.headers["x-upload-filename"] || ""));
  const extension = path.extname(uploadName).toLowerCase();
  const contentLength = Number(req.headers["content-length"]);

  if (!VIDEO_UPLOAD_EXTENSIONS.has(extension)) {
    return res.status(400).json({ ok: false, error: "supported video extensions: .ts, .m2ts, .mp4, .mov, .mkv" });
  }
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ ok: false, error: `video exceeds ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB upload limit` });
  }

  const assetId = `${randomUUID()}${extension}`;
  const temporaryPath = path.join(VIDEO_ROOT, `${assetId}.upload`);
  const destinationPath = path.join(VIDEO_ROOT, assetId);
  let receivedBytes = 0;
  const byteLimit = new Transform({
    transform(chunk, _encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_UPLOAD_BYTES) {
        callback(new Error(`video exceeds ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB upload limit`));
        return;
      }
      callback(null, chunk);
    }
  });

  try {
    await pipeline(req, byteLimit, fs.createWriteStream(temporaryPath, { flags: "wx" }));
    if (!receivedBytes) throw new Error("uploaded video file is empty");
    await fs.promises.rename(temporaryPath, destinationPath);
    log.info("video_upload_complete", { requestId: req.requestId, assetId, receivedBytes });
    res.status(201).json({ ok: true, assetId, sizeBytes: receivedBytes });
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    const message = String(error?.message || error);
    const status = message.includes("upload limit") ? 413 : 400;
    log.warn("video_upload_error", { requestId: req.requestId, error: serializeError(error) });
    res.status(status).json({ ok: false, error: message });
  }
});

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
    sourceType: s.sourceType,
    webRtcAvailable: s.sourceType !== "file",
    hlsMode: s.hlsMode,
    hlsEffectiveMode: s.hlsEffectiveMode,
    hlsFallbackReason: s.hlsFallbackReason,
    webRtcMode: s.webRtcMode,
    hlsEncoderMode: s.hlsEncoderMode,
    webRtcEncoderMode: s.webRtcEncoderMode,
    mode: s.mode,
    hlsSegmentSeconds: s.hlsSegmentSeconds,
    vttSegmentSeconds: s.vttSegmentSeconds,
    hlsMasterUrl: `/hls/${s.streamId}/master.m3u8`,
    posterUrl: s.poster?.state === "ready" ? `/hls/${encodeURIComponent(s.streamId)}/poster.jpg?v=${encodeURIComponent(s.poster.updatedAt)}` : null,
    posterState: s.poster?.state || "pending",
    webrtcReady: !!s.webrtc?.producerId,
    ...getSourceRuntime(s.streamId)
  }));

  for (const [streamId, tracked] of sourceStates.entries()) {
    if (sources.has(streamId)) continue;
    if (tracked?.state !== "starting" && tracked?.state !== "stopping") continue;
    list.push({
      streamId,
      inputUrl: tracked?.inputUrl || null,
      sourceType: tracked?.sourceType || "stream",
      webRtcAvailable: tracked?.webRtcAvailable !== false,
      hlsMode: tracked?.hlsMode || null,
      hlsEffectiveMode: tracked?.hlsEffectiveMode || null,
      hlsFallbackReason: tracked?.hlsFallbackReason || null,
      webRtcMode: tracked?.webRtcMode || null,
      hlsEncoderMode: tracked?.hlsEncoderMode || null,
      webRtcEncoderMode: tracked?.webRtcEncoderMode || null,
      mode: tracked?.mode || null,
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

// ---------- API: file-backed clips ----------
// Clips seek directly in the authoritative uploaded file. The export stream-copies
// every source stream, including KLV/data, into a new MPEG-TS container.
app.post("/sources/:streamId/clips", async (req, res) => {
  const streamId = req.params.streamId;
  const source = sources.get(streamId);
  if (!source || source.sourceType !== "file") {
    return res.status(409).json({ ok: false, error: "clipping is available only for an uploaded video source" });
  }
  if (currentSourceState(streamId) !== "ready") {
    return res.status(409).json({ ok: false, error: "wait for the uploaded video to finish packaging before creating a clip" });
  }

  const outDir = path.join(RECORD_ROOT, streamId);
  let requestedRange;
  let sourceInputPath;
  try {
    requestedRange = normalizeClipRange({
      startSeconds: req.body?.startSeconds,
      endSeconds: req.body?.endSeconds,
      durationSeconds: sourceStates.get(streamId)?.durationSeconds
    });
    sourceInputPath = path.resolve(String(source.inputUrl || ""));
    if (!sourceInputPath.startsWith(`${VIDEO_ROOT}${path.sep}`) || !fs.existsSync(sourceInputPath)) {
      throw new Error("uploaded source file is unavailable");
    }
  } catch (error) {
    return res.status(400).json({ ok: false, error: String(error?.message || error) });
  }

  const clipId = randomUUID();
  const clipDir = path.join(outDir, "clips");
  const filename = `${streamId}-clip-${clipId.slice(0, 8)}.ts`;
  const outputPath = path.join(clipDir, filename);
  const inputHasKlv = source.klvProbe?.available === true;

  try {
    await fs.promises.mkdir(clipDir, { recursive: true });
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      // Input seeking is deliberate: with stream copy, FFmpeg begins at a
      // nearby preceding decodable keyframe rather than re-encoding a GOP.
      "-copy_unknown",
      "-ss", String(requestedRange.start),
      "-t", String(requestedRange.duration),
      "-i", sourceInputPath,
      "-map", "0",
      "-map_metadata", "0",
      "-c", "copy",
      "-muxpreload", "0",
      "-muxdelay", "0",
      // Start a fresh transport-stream timeline for reliable player duration
      // estimation. KLV's embedded UTC remains source-authentic.
      "-mpegts_copyts", "0",
      "-mpegts_flags", "+initial_discontinuity",
      "-avoid_negative_ts", "make_zero",
      "-f", "mpegts",
      outputPath
    ];
    log.info("clip_export_start", {
      streamId,
      clipId,
      sourceInputPath,
      requestedStartSeconds: requestedRange.start,
      requestedEndSeconds: requestedRange.end,
      requestedDurationSeconds: requestedRange.duration,
      inputHasKlv
    });
    await runFfmpeg(args, { label: "clip export" });

    const outputProbe = await probeInputWithFfprobe(outputPath);
    if (!outputProbe.hasVideo) throw new Error("clip export did not contain a video stream");
    if (inputHasKlv && !outputProbe.klv?.available) {
      throw new Error("clip export did not retain the source KLV data stream");
    }

    const clip = {
      clipId,
      filename,
      path: outputPath,
      startSeconds: requestedRange.start,
      endSeconds: requestedRange.end,
      requestedStartSeconds: requestedRange.start,
      requestedEndSeconds: requestedRange.end,
      durationSeconds: outputProbe.durationSeconds ?? requestedRange.duration,
      trimMode: "source-seek-keyframe-copy",
      klvEmbedded: !!outputProbe.klv?.available,
      createdAt: new Date().toISOString()
    };
    if (!source.clips) source.clips = new Map();
    source.clips.set(clipId, clip);
    log.info("clip_export_complete", { streamId, clipId, durationSeconds: clip.durationSeconds, klvEmbedded: clip.klvEmbedded });
    return res.status(201).json({
      ok: true,
      clip: {
        ...clip,
        downloadUrl: `/sources/${encodeURIComponent(streamId)}/clips/${encodeURIComponent(clipId)}/download`
      }
    });
  } catch (error) {
    await fs.promises.rm(outputPath, { force: true }).catch(() => {});
    const message = String(error?.message || error);
    log.warn("clip_export_error", { streamId, clipId, error: serializeError(error) });
    return res.status(500).json({ ok: false, error: message });
  }
});

app.get("/sources/:streamId/clips/:clipId/download", async (req, res) => {
  const source = sources.get(req.params.streamId);
  const clip = source?.clips?.get(req.params.clipId);
  if (!clip || !fs.existsSync(clip.path)) {
    return res.status(404).json({ ok: false, error: "clip not found" });
  }
  return res.download(clip.path, clip.filename);
});

// ---------- API: authoritative file snapshots ----------
// File sources can be captured from the original uploaded asset rather than
// from the browser's currently decoded HLS frame.
app.post("/sources/:streamId/snapshot", async (req, res) => {
  const streamId = req.params.streamId;
  const source = sources.get(streamId);
  if (!source || source.sourceType !== "file") {
    return res.status(409).json({ ok: false, error: "authoritative snapshots are available only for an uploaded video source" });
  }

  const timeSeconds = Number(req.body?.timeSeconds);
  const sourceDurationSeconds = Number(sourceStates.get(streamId)?.durationSeconds);
  if (!Number.isFinite(timeSeconds) || timeSeconds < 0) {
    return res.status(400).json({ ok: false, error: "snapshot time must be a valid non-negative media time" });
  }
  if (Number.isFinite(sourceDurationSeconds) && timeSeconds > sourceDurationSeconds + 0.05) {
    return res.status(400).json({ ok: false, error: "snapshot time is outside the uploaded video duration" });
  }

  const sourceInputPath = path.resolve(String(source.inputUrl || ""));
  if (!sourceInputPath.startsWith(`${VIDEO_ROOT}${path.sep}`) || !fs.existsSync(sourceInputPath)) {
    return res.status(409).json({ ok: false, error: "uploaded source file is unavailable" });
  }

  const snapshotId = randomUUID();
  const snapshotDir = path.join(RECORD_ROOT, streamId, "snapshots");
  const filename = `${streamId}-source-snapshot-${snapshotId.slice(0, 8)}.jpg`;
  const outputPath = path.join(snapshotDir, filename);
  const normalizedTimeSeconds = Number(timeSeconds.toFixed(3));

  try {
    await fs.promises.mkdir(snapshotDir, { recursive: true });
    await runFfmpeg([
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-i", sourceInputPath,
      // Output-side seeking decodes to the requested media time, avoiding a
      // keyframe-only browser-frame approximation for file snapshots.
      "-ss", String(normalizedTimeSeconds),
      "-map", "0:v:0",
      "-frames:v", "1",
      "-q:v", "2",
      outputPath
    ], { label: "authoritative snapshot", timeoutMs: AUTHORITATIVE_SNAPSHOT_TIMEOUT_MS });

    log.info("authoritative_snapshot_ready", { streamId, snapshotId, sourceInputPath, timeSeconds: normalizedTimeSeconds });
    return res.download(outputPath, filename, (error) => {
      void fs.promises.rm(outputPath, { force: true }).catch(() => {});
      if (error && !res.headersSent) {
        res.status(500).json({ ok: false, error: String(error.message || error) });
      }
    });
  } catch (error) {
    await fs.promises.rm(outputPath, { force: true }).catch(() => {});
    log.warn("authoritative_snapshot_error", { streamId, snapshotId, error: serializeError(error) });
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/sources", async (req, res) => {
  let requestedStreamId = null;
  let hls = null;
  let klvWorker = null;
  let startedSfuIngest = false;
  let sourceType = "stream";
  let producerId = null;
  let purgeResult = null;

  try {
    const {
  streamId,
  inputUrl,
  sourceType: requestedSourceType = "stream",
  assetId,
  hlsMode: requestedHlsMode = "passthrough",
  webRtcMode: requestedWebRtcMode = "auto",
  hlsSegmentSeconds = 1,
  vttSegmentSeconds = 5,
  purgeBeforeStart = false,

  // Variable-rate VTT tuning
  maxCuesPerSecond = 10,
  minCueDurSec = 0.10,
  maxCueDurSec = 0.50
} = req.body || {};
    sourceType = normalizeSourceType(requestedSourceType);
    const hlsMode = normalizeHlsMode(requestedHlsMode);
    const webRtcMode = normalizeWebRtcMode(requestedWebRtcMode);
    const resolvedInputUrl = sourceType === "file"
      ? resolveUploadedVideo(assetId)
      : (typeof inputUrl === "string" ? inputUrl.trim() : "");
    requestedStreamId = streamId;
    if (!streamId || !resolvedInputUrl) throw new Error("streamId and inputUrl required");

    let sourceProbe = null;
    let fileDurationSeconds = null;
    try {
        sourceProbe = await probeInputWithFfprobe(resolvedInputUrl);
        if (sourceType === "file") {
          const probe = sourceProbe;
        fileDurationSeconds = probe.durationSeconds;
        }
    } catch (error) {
      log.warn("source_probe_error", { streamId, sourceType, error: serializeError(error) });
    }
    // A UDP stream can start before its next video header/keyframe reaches the
    // short general probe. Retry only when dimensions are missing so ABR uses
    // the true source-native top rung instead of the 1920x1080 fallback.
    if (sourceType === "stream" && !hasVideoDimensions(sourceProbe)) {
      try {
        const dimensionProbe = await probeInputWithFfprobe(resolvedInputUrl, {
          timeoutMs: LIVE_DIMENSION_PROBE_TIMEOUT_MS,
          analyzeDurationUs: 10_000_000,
          probeSizeBytes: 32_000_000,
          readInterval: "%+10"
        });
        if (hasVideoDimensions(dimensionProbe)) {
          sourceProbe = mergeLiveProbe(sourceProbe, dimensionProbe);
          log.info("source_dimension_probe_complete", {
            streamId,
            width: sourceProbe.video.width,
            height: sourceProbe.video.height
          });
        }
      } catch (error) {
        log.warn("source_dimension_probe_error", { streamId, error: serializeError(error) });
      }
    }
    const hlsResolution = resolveHlsEncodeMode(hlsMode, sourceProbe);
    const hlsEncoderMode = hlsResolution.encoderMode;
    const hlsEffectiveMode = hlsResolution.effectiveMode;
    const hlsFallbackReason = hlsResolution.fallbackReason;
    const webRtcEncoderMode = sourceType === "file"
      ? null
      : resolveWebRtcEncodeMode(webRtcMode, sourceProbe);
    const mode = hlsEncoderMode;
    const effectiveSegmentSeconds = normalizeSegmentSeconds(
      hlsSegmentSeconds,
      normalizeSegmentSeconds(vttSegmentSeconds, 1)
    );

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
      inputUrl: resolvedInputUrl,
      sourceType,
      webRtcAvailable: sourceType !== "file",
      hlsMode,
      hlsEffectiveMode,
      hlsFallbackReason,
      webRtcMode,
      hlsEncoderMode,
      webRtcEncoderMode,
      klvProbe: sourceProbe?.klv || null,
      sourceVideo: sourceProbe?.video || null,
      durationSeconds: fileDurationSeconds,
      processedSeconds: sourceType === "file" ? 0 : null,
      progressPercent: sourceType === "file" ? 0 : null,
      encodeSpeed: null,
      etaSeconds: null,
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
      inputUrl: resolvedInputUrl,
      sourceType,
      hlsMode,
      hlsEffectiveMode,
      hlsFallbackReason,
      webRtcMode,
      hlsEncoderMode,
      webRtcEncoderMode,
      detectedVideoCodec: sourceProbe?.video?.codec || null,
      detectedAudioCodec: sourceProbe?.audio?.codec || null,
      hlsSegmentSeconds: effectiveSegmentSeconds,
      vttSegmentSeconds: effectiveSegmentSeconds,
      purgeBeforeStart
    });

    const outDir = path.join(RECORD_ROOT, streamId);
    await fs.promises.mkdir(outDir, { recursive: true });

    // 1) DVR recorder (HLS MPEG-TS) — provides PROGRAM-DATE-TIME timestamps
    hls = startHlsRecorder({
      streamId,
      inputUrl: resolvedInputUrl,
      outDir,
      hlsSegmentSeconds: effectiveSegmentSeconds,
      mode: hlsEncoderMode,
      sourceType,
      sourceVideo: sourceProbe?.video || null,
      onProgress: ({ processedSeconds, speed, complete }) => {
        if (sourceType !== "file" || !Number.isFinite(processedSeconds)) return;
        const clampedProcessedSeconds = Number.isFinite(fileDurationSeconds)
          ? Math.min(processedSeconds, fileDurationSeconds)
          : processedSeconds;
        const progressPercent = Number.isFinite(fileDurationSeconds) && fileDurationSeconds > 0
          ? Math.min(100, (clampedProcessedSeconds / fileDurationSeconds) * 100)
          : null;
        const etaSeconds = Number.isFinite(fileDurationSeconds) && Number.isFinite(speed) && speed > 0
          ? Math.max(0, (fileDurationSeconds - clampedProcessedSeconds) / speed)
          : null;
        setSourceState(streamId, {
          processedSeconds: clampedProcessedSeconds,
          progressPercent: complete ? 100 : progressPercent,
          encodeSpeed: speed,
          etaSeconds: complete ? 0 : etaSeconds
        });
      },
      requestId: req.requestId
    });

    // TS duration is often absent from the short ffprobe read.  Resolve it in
    // the background so source start is not delayed, then immediately turn the
    // already-reported processed time into an accurate percentage.
    if (sourceType === "file" && (!Number.isFinite(fileDurationSeconds) || fileDurationSeconds <= 0)) {
      void probeMpegTsDurationFromPcr(resolvedInputUrl)
        .then((derivedDurationSeconds) => {
          if (!Number.isFinite(derivedDurationSeconds) || derivedDurationSeconds <= 0) return;
          fileDurationSeconds = derivedDurationSeconds;
          const tracked = sourceStates.get(streamId);
          if (!tracked || tracked.inputUrl !== resolvedInputUrl || tracked.state === "stopped") return;
          const processedSeconds = Number(tracked.processedSeconds);
          const clampedProcessedSeconds = Number.isFinite(processedSeconds)
            ? Math.min(processedSeconds, fileDurationSeconds)
            : 0;
          const speed = Number(tracked.encodeSpeed);
          setSourceState(streamId, {
            durationSeconds: fileDurationSeconds,
            processedSeconds: clampedProcessedSeconds,
            progressPercent: Math.min(100, (clampedProcessedSeconds / fileDurationSeconds) * 100),
            etaSeconds: Number.isFinite(speed) && speed > 0
              ? Math.max(0, (fileDurationSeconds - clampedProcessedSeconds) / speed)
              : null
          });
          log.info("file_duration_derived_from_pcr", {
            streamId,
            durationSeconds: Number(fileDurationSeconds.toFixed(3))
          });
        })
        .catch((error) => {
          log.warn("file_duration_pcr_probe_error", { streamId, error: serializeError(error) });
        });
    }
    setSourceState(streamId, {
      state: "starting",
      stage: "hls_started",
      encoder: hls.encoder,
      usingGpu: hls.usingGpu,
      hlsRenditions: hls.renditions,
      copyNativeTopRung: hls.copyNativeTopRung
    });

    // Write the master playlist before the recorder begins publishing media playlists.
    const masterPath = path.join(outDir, "master.m3u8");
    await bootstrapSubtitleArtifacts(outDir, effectiveSegmentSeconds);
    await fs.promises.writeFile(
      masterPath,
      hls.isAbr ? createHlsMasterPlaylist(hls.renditions) : createPassthroughHlsMasterPlaylist()
    );

    // 2) KLV ingest + DB/VTT sidecar in dedicated worker process
    klvWorker = await startKlvStreamWorker({
      streamId,
      inputUrl: resolvedInputUrl,
      sourceType,
      outDir,
      videoPlaylistName: hls.videoPlaylistName,
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

    // 3) WebRTC is a live-stream path. File sources are packaged for HLS/VTT playback only.
    if (sourceType !== "file") {
      const ingest = await sfuClient.startIngest({
        streamId,
        inputUrl: resolvedInputUrl,
        mode: webRtcEncoderMode,
        requestId: req.requestId
      });
      startedSfuIngest = true;
      producerId = ingest.producerId;
      setSourceState(streamId, {
        state: "starting",
        stage: "ingest_ready",
        ingestRunning: true
      });
    }

    sources.set(streamId, {
      streamId,
      inputUrl: resolvedInputUrl,
      sourceType,
      mode,
      hlsMode,
      hlsEffectiveMode,
      hlsFallbackReason,
      webRtcMode,
      hlsEncoderMode,
      webRtcEncoderMode,
      hlsSegmentSeconds: effectiveSegmentSeconds,
      vttSegmentSeconds: effectiveSegmentSeconds,
      maxCuesPerSecond: Number(maxCuesPerSecond) || 10,
      minCueDurSec: Number(minCueDurSec) || 0.10,
      maxCueDurSec: Number(maxCueDurSec) || 0.50,
      hlsRenditions: hls.renditions,
      copyNativeTopRung: hls.copyNativeTopRung,
      klvProbe: sourceProbe?.klv || null,
      sourceVideo: sourceProbe?.video || null,
      hls, klvWorker,
      clips: new Map(),
      poster: { state: "pending", updatedAt: new Date().toISOString(), error: null },
      webrtc: sourceType === "file" ? null : { ingestRunning: true, producerId }
    });
    queueSourcePoster(streamId);

    const finalizeFileSource = async () => {
      const source = sources.get(streamId);
      if (!source || source.sourceType !== "file") return;
      setSourceState(streamId, { state: "finalizing", running: false, ingestRunning: false, stage: "finalizing_vtt" });
      try {
        const finalizeTimeoutMs = estimateKlvFinalizeTimeoutMs(
          sourceStates.get(streamId)?.durationSeconds,
          source.hlsSegmentSeconds
        );
        log.info("file_klv_finalization_start", { streamId, finalizeTimeoutMs });
        await finalizeKlvStreamWorker(source.klvWorker, { timeoutMs: finalizeTimeoutMs });
        await stopKlvStreamWorker(source.klvWorker);
        source.klvWorker = null;
        setSourceState(streamId, {
          state: "ready",
          running: false,
          ingestRunning: false,
          stage: null,
          progressPercent: 100,
          etaSeconds: 0,
          lastError: null
        });
        log.info("file_source_ready", { streamId });
      } catch (error) {
        setSourceState(streamId, {
          state: "error",
          running: false,
          ingestRunning: false,
          stage: null,
          lastError: `file finalization failed: ${String(error?.message || error)}`
        });
      }
    };

    const onWorkerExit = (service, code, signal) => {
      if (!sources.has(streamId)) return;
      const currentState = currentSourceState(streamId);
      if (currentState === "stopping" || currentState === "stopped") return;
      if (sourceType === "file" && service === "hls_recorder" && code === 0 && !signal) {
        void finalizeFileSource();
        return;
      }
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
      ingestRunning: sourceType !== "file",
      lastError: null
    });

    if (sourceType === "file" && hls.proc?.exitCode === 0) {
      void finalizeFileSource();
    }

    log.info("source_create_success", { streamId, sourceType, producerId });

    res.json({
      ok: true,
      streamId,
      hlsMasterUrl: `/hls/${streamId}/master.m3u8`,
      subtitlesUrl: `/hls/${streamId}/subtitles.m3u8`,
      sourceType,
      hlsMode,
      hlsEffectiveMode,
      hlsFallbackReason,
      webRtcMode,
      hlsEncoderMode,
      webRtcEncoderMode,
      webrtc: sourceType === "file" ? { available: false } : { available: true, producerId },
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
  setSourceState(streamId, {
    state: "stopping",
    running: false,
    ingestRunning: false,
    stage: "teardown",
    processedSeconds: null,
    progressPercent: null,
    encodeSpeed: null,
    etaSeconds: null
  });
  sources.delete(streamId);

  await stopKlvStreamWorker(s.klvWorker);
  await stopHlsRecorder(s.hls);
  await sfuClient.stopIngest(streamId);

  setSourceState(streamId, {
    state: "stopped",
    running: false,
    ingestRunning: false,
    stage: null,
    processedSeconds: null,
    progressPercent: null,
    encodeSpeed: null,
    etaSeconds: null,
    lastError: null
  });
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
    const message = String(e?.message || e);
    if (message === "SFU client not initialized" || message === "SFU worker is not running") {
      res.status(503).json({ ok: false, retryable: true, error: message });
      return;
    }
    log.error("webrtc_debug_error", { error: serializeError(e) });
    res.status(500).json({ ok: false, error: message });
  }
});

// ---------- Runtime metrics / health ----------
app.get("/metrics/runtime", async (req, res) => {
  const runtime = getRuntimeMetricsSnapshot();
  runtime.host.gpu = await getGpuMetrics();
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

/** Tests whether the HTTP server can bind a requested local port. */
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

/** Selects an available HTTP port from the configured fallback range. */
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
let shutdownForceKillPids = new Set();

/** Adds a valid child process ID to a tracked PID set. */
function addPid(targetSet, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  targetSet.add(pid);
}

/** Captures currently running backend child PIDs for shutdown cleanup. */
function snapshotBackendChildPids() {
  const pids = new Set();
  try {
    addPid(pids, sfuClient?.proc?.pid ?? null);
  } catch {}
  for (const source of sources.values()) {
    addPid(pids, source?.hls?.proc?.pid ?? null);
    addPid(pids, source?.klvWorker?.proc?.pid ?? null);
  }
  return pids;
}

/** Force-kills a child process and its descendants on the current platform. */
function forceKillProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (process.platform === "win32") {
      const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      return result.status === 0;
    }
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

/** Force-kills every process in a tracked PID set and logs the reason. */
function forceKillPidSet(pidSet, reason) {
  if (!pidSet || !pidSet.size) return;
  const attempted = [];
  const killed = [];
  for (const pid of pidSet) {
    attempted.push(pid);
    if (forceKillProcessTree(pid)) killed.push(pid);
  }
  log.warn("shutdown_force_kill_sweep", {
    reason,
    attemptedPids: attempted,
    killedPids: killed
  });
}

/** Performs ordered service shutdown, including sources, workers, and child processes. */
async function shutdown(signal) {
  if (shuttingDown) {
    log.warn("shutdown_already_in_progress", { signal });
    forceKillPidSet(shutdownForceKillPids, "second_signal");
    process.exit(1);
    return;
  }
  shuttingDown = true;
  log.info("shutdown_start", { signal });
  shutdownForceKillPids = snapshotBackendChildPids();

  const forceExitTimer = setTimeout(() => {
    forceKillPidSet(shutdownForceKillPids, "shutdown_timeout");
    log.error("shutdown_force_exit_timeout", { timeoutMs: SHUTDOWN_FORCE_EXIT_MS });
    process.exit(1);
  }, SHUTDOWN_FORCE_EXIT_MS);
  forceExitTimer.unref?.();

  const withTimeout = async (promise, label, timeoutMs = 3000) => {
    let timeoutHandle = null;
    try {
      await Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
          timeoutHandle.unref?.();
        })
      ]);
    } catch (error) {
      log.warn("shutdown_step_failed", { label, error: serializeError(error) });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  };

  // Stop accepting new HTTP connections early.
  const closeServerPromise = new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });

  // Close WS clients and listener.
  try {
    for (const client of wss.clients) {
      try { client.terminate(); } catch {}
    }
  } catch {}
  try { wss.close(); } catch {}

  const entries = [...sources.entries()];
  await Promise.allSettled(entries.map(async ([streamId, s]) => {
    sources.delete(streamId);
    addPid(shutdownForceKillPids, s?.hls?.proc?.pid ?? null);
    addPid(shutdownForceKillPids, s?.klvWorker?.proc?.pid ?? null);
    await withTimeout(stopKlvStreamWorker(s.klvWorker), `stopKlvStreamWorker(${streamId})`, 4000);
    await withTimeout(stopHlsRecorder(s.hls), `stopHlsRecorder(${streamId})`, 4000);
    await withTimeout(sfuClient.stopIngest(streamId), `sfuClient.stopIngest(${streamId})`, 4000);
  }));

  await withTimeout(sfuClient.close(), "sfuClient.close", 4000);
  await withTimeout(store.close(), "store.close", 4000);

  // Ensure no keep-alive sockets prevent server close callback.
  for (const socket of httpSockets) {
    try { socket.destroy(); } catch {}
  }
  await withTimeout(closeServerPromise, "server.close", 4000);

  // Final best-effort sweep in case descendants (e.g., ffmpeg) survived graceful stop.
  for (const pid of snapshotBackendChildPids()) shutdownForceKillPids.add(pid);
  forceKillPidSet(shutdownForceKillPids, "final_sweep");

  clearTimeout(forceExitTimer);
  shutdownForceKillPids = new Set();
  process.exit(0);
}

process.on("SIGINT", () => { shutdown("SIGINT").catch(() => process.exit(1)); });
process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(1)); });
process.on("SIGBREAK", () => { shutdown("SIGBREAK").catch(() => process.exit(1)); });
