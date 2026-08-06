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
import { readCompletedHlsPlaylistAvailability } from "./src/hls_playlist_availability.js";
import { finalizeKlvStreamWorker, startKlvStreamWorker, stopKlvStreamWorker } from "./src/klv_stream_worker_client.js";
import { startSfuWorkerClient } from "./src/sfu_worker_client.js";
import { SqliteKlvStore } from "./src/storage/sqlite_klv_store.js";
import { registerOgcMovingFeaturesRoutes } from "./src/ogc_moving_features.js";
import { getProcessCpuPercents, getRuntimeMetricsSnapshot } from "./src/runtime_metrics.js";
import { getGpuMetrics } from "./src/gpu_metrics.js";
import { checkMediaTools } from "./src/media_tool_preflight.js";
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
const FILE_INTEGRITY_SCAN_TIMEOUT_MS = Math.max(10_000, Number(process.env.FILE_INTEGRITY_SCAN_TIMEOUT_MS || (10 * 60 * 1000)));
const FILE_INTEGRITY_SCAN_STDERR_LIMIT = 64 * 1024;
const SHUTDOWN_FORCE_EXIT_MS = Math.max(1000, Number(process.env.SHUTDOWN_FORCE_EXIT_MS || 10000));
// Set only by scripts/service-manager.mjs.  Keeping this unset preserves the
// normal direct-start behaviour while preventing unauthenticated HTTP shutdowns.
const SHUTDOWN_CONTROL_TOKEN = process.env.SHUTDOWN_CONTROL_TOKEN || "";
const log = createServiceLogger("server");

// Keep this immutable for the service lifetime: the selected executables and
// encoder come from startup environment, and repeatedly encoding a test frame
// on every health request would add unnecessary GPU work.
const mediaTools = checkMediaTools({ ffprobeCommand: FFPROBE_BIN });
log[mediaTools.ok ? "info" : "warn"]("media_tools_checked", mediaTools);

const RECORD_ROOT = path.resolve("./recordings");
const DB_DIR = path.resolve("./db");
const SOURCE_ASSET_DIRNAME = "source";
const SOURCE_UPLOAD_DIRNAME = ".uploads";
const MAX_UPLOAD_BYTES = Math.max(1, Number(process.env.MAX_VIDEO_UPLOAD_MB || 10_240)) * 1024 * 1024;
const VIDEO_UPLOAD_EXTENSIONS = new Set([".ts", ".m2ts", ".mp4", ".mov", ".mkv"]);
// A server-path source is deliberately limited to configured roots. On Windows
// separate multiple roots with `;`; on POSIX use `:` (Node's path delimiter).
const DEFAULT_LOCAL_VIDEO_SOURCE_ROOT = path.resolve("./videos");
const LOCAL_VIDEO_SOURCE_ROOTS = String(process.env.LOCAL_VIDEO_SOURCE_ROOTS || DEFAULT_LOCAL_VIDEO_SOURCE_ROOT)
  .split(path.delimiter)
  .map((root) => root.trim())
  .filter(Boolean)
  .map((root) => path.resolve(root));
const CLIP_MIN_DURATION_SECONDS = 0.25;
// Leave clip duration unrestricted by default. Deployments that need a policy
// limit can set MAX_CLIP_DURATION_SECONDS to a positive number.
const CLIP_MAX_DURATION_SECONDS = Number(process.env.MAX_CLIP_DURATION_SECONDS || 0);
const SOURCE_POSTER_WIDTH = Math.max(96, Math.min(320, Number(process.env.SOURCE_POSTER_WIDTH || 160)));
const SOURCE_POSTER_TIMEOUT_MS = Math.max(3000, Number(process.env.SOURCE_POSTER_TIMEOUT_MS || 15000));
const AUTHORITATIVE_SNAPSHOT_TIMEOUT_MS = Math.max(3000, Number(process.env.AUTHORITATIVE_SNAPSHOT_TIMEOUT_MS || 30000));
// A TS seek may require substantial demux work when no index is available.
// Keep the established 12-frame filmstrip by default, while allowing an
// operator to reduce it for constrained environments.
const CLIP_THUMBNAIL_COUNT = Math.max(4, Math.min(12, Number(process.env.CLIP_THUMBNAIL_COUNT || 12)));
const CLIP_THUMBNAIL_WIDTH = 160;
const CLIP_THUMBNAIL_TIMEOUT_MS = Math.max(5000, Number(process.env.CLIP_THUMBNAIL_TIMEOUT_MS || 45000));
const KLV_FINALIZE_MIN_TIMEOUT_MS = Math.max(30000, Number(process.env.KLV_FINALIZE_MIN_TIMEOUT_MS || 30000));
const KLV_FINALIZE_MS_PER_SEGMENT = Math.max(50, Number(process.env.KLV_FINALIZE_MS_PER_SEGMENT || 500));
const KLV_FINALIZE_MAX_TIMEOUT_MS = Math.max(KLV_FINALIZE_MIN_TIMEOUT_MS, Number(process.env.KLV_FINALIZE_MAX_TIMEOUT_MS || 2 * 60 * 60 * 1000));
const PLATFORM_HISTORY_MAX_POINTS = Math.max(2, Math.min(10_000, Number(process.env.PLATFORM_HISTORY_MAX_POINTS || 5000)));

fs.mkdirSync(RECORD_ROOT, { recursive: true });
fs.mkdirSync(DB_DIR, { recursive: true });
if (!process.env.LOCAL_VIDEO_SOURCE_ROOTS) fs.mkdirSync(DEFAULT_LOCAL_VIDEO_SOURCE_ROOT, { recursive: true });

/** Removes generated recording artifacts before a new service session begins. */
async function purgeRecordingsOnStartup() {
  const expectedRoot = path.resolve("./recordings");
  if (RECORD_ROOT !== expectedRoot || path.basename(RECORD_ROOT).toLowerCase() !== "recordings") {
    throw new Error(`refusing to purge unexpected recording root: ${RECORD_ROOT}`);
  }
  await fs.promises.rm(RECORD_ROOT, { recursive: true, force: true });
  await fs.promises.mkdir(RECORD_ROOT, { recursive: true });
  log.info("startup_recordings_purge_complete", { recordRoot: RECORD_ROOT });
}

const activeResumableUploads = new Set();
const clipThumbnailJobs = new Map();

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
await purgeRecordingsOnStartup();
const store = new SqliteKlvStore({ dbPath: path.join(DB_DIR, "klv.sqlite") });
await store.init();
const startupDatabasePurge = await store.purgeAllMissionData();
log.info("startup_database_purge_complete", startupDatabasePurge);

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

const TRANSPORT_INTEGRITY_FINDINGS = [
  {
    code: "transport_sync_lost",
    pattern: /max resync size reached, could not find sync byte/i,
    message: "Transport-stream sync was lost."
  },
  {
    code: "pes_size_mismatch",
    pattern: /PES packet size mismatch/i,
    message: "A transport PES packet has an invalid size."
  },
  {
    code: "corrupt_packet",
    pattern: /(?:packet corrupt|corrupt input packet)/i,
    message: "One or more corrupt transport packets were found."
  },
  {
    code: "continuity_error",
    pattern: /continuity check failed/i,
    message: "A transport-stream continuity error was found."
  }
];

const ISO_BASE_MEDIA_INTEGRITY_FINDINGS = [
  {
    code: "missing_moov_atom",
    pattern: /moov atom not found/i,
    message: "The MP4/MOV metadata atom is missing or truncated."
  },
  {
    code: "invalid_sample_table",
    pattern: /(?:invalid sample description|invalid stsc|invalid stco|invalid stsz)/i,
    message: "The MP4/MOV sample table is invalid."
  },
  {
    code: "truncated_media_data",
    pattern: /(?:partial file|truncated|unexpected eof)/i,
    message: "The MP4/MOV file ends before all media data is available."
  }
];

const MATROSKA_INTEGRITY_FINDINGS = [
  {
    code: "invalid_ebml_header",
    pattern: /(?:ebml header parsing failed|invalid ebml number)/i,
    message: "The MKV EBML header is invalid."
  },
  {
    code: "invalid_cluster",
    pattern: /(?:invalid cluster|invalid element size)/i,
    message: "An MKV cluster or element is invalid."
  },
  {
    code: "truncated_media_data",
    pattern: /(?:partial file|truncated|unexpected eof)/i,
    message: "The MKV file ends before all media data is available."
  }
];

const GENERIC_FILE_INTEGRITY_FINDINGS = [
  {
    code: "invalid_media_data",
    pattern: /invalid data found when processing input/i,
    message: "The container contains invalid media data."
  }
];

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

/** Validates a stream ID and resolves its server-owned recording directory. */
function resolveStreamRecordingDir(streamId) {
  if (typeof streamId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(streamId)) {
    throw new Error("stream ID must contain only letters, numbers, hyphens, or underscores");
  }
  const outDir = path.resolve(RECORD_ROOT, streamId);
  if (!outDir.startsWith(`${RECORD_ROOT}${path.sep}`)) throw new Error("invalid stream recording path");
  return outDir;
}

/** Resolves the directory holding one stream's authoritative uploaded assets. */
function resolveSourceAssetDir(streamId) {
  const outDir = resolveStreamRecordingDir(streamId);
  const sourceDir = path.resolve(outDir, SOURCE_ASSET_DIRNAME);
  if (!sourceDir.startsWith(`${outDir}${path.sep}`)) throw new Error("invalid source asset path");
  return sourceDir;
}

/** Tests whether a candidate is a path inside a configured directory. */
function isPathInside(rootDir, candidatePath) {
  const root = process.platform === "win32" ? rootDir.toLowerCase() : rootDir;
  const candidate = process.platform === "win32" ? candidatePath.toLowerCase() : candidatePath;
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/** Resolves a regular video file inside a configured local-server source root. */
async function resolveLocalServerVideo(inputPath) {
  if (typeof inputPath !== "string" || !inputPath.trim()) {
    throw new Error("local server video path is required");
  }
  const requestedPath = inputPath.trim();
  if (!VIDEO_UPLOAD_EXTENSIONS.has(path.extname(requestedPath).toLowerCase())) {
    throw new Error("supported video extensions: .ts, .m2ts, .mp4, .mov, .mkv");
  }
  const realRoots = (await Promise.all(LOCAL_VIDEO_SOURCE_ROOTS.map(async (root) => {
    try { return await fs.promises.realpath(root); } catch { return null; }
  }))).filter(Boolean);

  const candidatePaths = path.isAbsolute(requestedPath)
    ? [path.resolve(requestedPath)]
    : LOCAL_VIDEO_SOURCE_ROOTS.map((root) => path.resolve(root, requestedPath));
  for (const candidatePath of candidatePaths) {
    try {
      const candidateStat = await fs.promises.stat(candidatePath);
      if (!candidateStat.isFile()) continue;
      const realCandidatePath = await fs.promises.realpath(candidatePath);
      if (!realRoots.some((root) => isPathInside(root, realCandidatePath))) continue;
      return { path: realCandidatePath, sizeBytes: candidateStat.size, filename: path.basename(realCandidatePath) };
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    }
  }
  throw new Error(path.isAbsolute(requestedPath)
    ? "local server video must be a regular file inside a configured LOCAL_VIDEO_SOURCE_ROOTS directory"
    : "local server video was not found below the configured LOCAL_VIDEO_SOURCE_ROOTS directories");
}

/** Copies a configured local-server video into its stream's private source area. */
async function copyLocalServerVideo(streamId, inputPath) {
  const localVideo = await resolveLocalServerVideo(inputPath);
  const sourceDir = resolveSourceAssetDir(streamId);
  const assetId = `${randomUUID()}${path.extname(localVideo.filename).toLowerCase()}`;
  const destinationPath = path.resolve(sourceDir, assetId);
  if (!isPathInside(sourceDir, destinationPath)) throw new Error("invalid local video destination path");

  await fs.promises.mkdir(sourceDir, { recursive: true });
  await fs.promises.copyFile(localVideo.path, destinationPath, fs.constants.COPYFILE_EXCL);
  return { assetId, sizeBytes: localVideo.sizeBytes, sourceFilename: localVideo.filename };
}

/** Lists supported regular video files available below configured local roots. */
async function listLocalServerVideos() {
  const videos = [];
  const realRoots = (await Promise.all(LOCAL_VIDEO_SOURCE_ROOTS.map(async (root) => {
    try { return { configuredRoot: root, realRoot: await fs.promises.realpath(root) }; } catch { return null; }
  }))).filter(Boolean);

  const walk = async (configuredRoot, realRoot, currentDir) => {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const candidatePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(configuredRoot, realRoot, candidatePath);
        continue;
      }
      // Do not traverse symlinks while enumerating. A symlink is separately
      // accepted by the copy endpoint only after its real target is validated.
      if (!entry.isFile() || !VIDEO_UPLOAD_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const realPath = await fs.promises.realpath(candidatePath).catch(() => null);
      if (!realPath || !isPathInside(realRoot, realPath)) continue;
      const stat = await fs.promises.stat(realPath).catch(() => null);
      if (!stat?.isFile()) continue;
      const relativePath = path.relative(configuredRoot, candidatePath);
      videos.push({
        inputPath: realPath,
        relativePath: LOCAL_VIDEO_SOURCE_ROOTS.length > 1
          ? `${path.basename(configuredRoot)}${path.sep}${relativePath}`
          : relativePath,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString()
      });
    }
  };

  for (const { configuredRoot, realRoot } of realRoots) await walk(configuredRoot, realRoot, configuredRoot);
  videos.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true, sensitivity: "base" }));
  return videos;
}

/** Validates and resolves a server-owned uploaded video asset path. */
function resolveUploadedVideo(streamId, assetId) {
  if (typeof assetId !== "string" || !/^[a-f0-9-]{36}\.(?:ts|m2ts|mp4|mov|mkv)$/i.test(assetId)) {
    throw new Error("invalid uploaded video asset ID");
  }
  const sourceDir = resolveSourceAssetDir(streamId);
  const inputUrl = path.resolve(sourceDir, assetId);
  if (!inputUrl.startsWith(`${sourceDir}${path.sep}`) || !fs.existsSync(inputUrl)) {
    throw new Error("uploaded video file not found");
  }
  return inputUrl;
}

/** Validates a resumable-upload session ID and resolves its server-owned files. */
function resumableUploadPaths(streamId, uploadId) {
  if (typeof uploadId !== "string" || !/^[a-f0-9-]{36}$/i.test(uploadId)) {
    throw new Error("invalid resumable upload ID");
  }
  const sourceDir = resolveSourceAssetDir(streamId);
  const uploadDir = path.resolve(sourceDir, SOURCE_UPLOAD_DIRNAME);
  const partPath = path.resolve(uploadDir, `${uploadId}.part`);
  const metaPath = path.resolve(uploadDir, `${uploadId}.json`);
  if (!partPath.startsWith(`${uploadDir}${path.sep}`) || !metaPath.startsWith(`${uploadDir}${path.sep}`)) {
    throw new Error("invalid resumable upload path");
  }
  return { sourceDir, uploadDir, partPath, metaPath };
}

/** Loads one persisted resumable-upload session and its current byte offset. */
async function loadResumableUpload(streamId, uploadId) {
  const { sourceDir, uploadDir, partPath, metaPath } = resumableUploadPaths(streamId, uploadId);
  let session;
  try {
    session = JSON.parse(await fs.promises.readFile(metaPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("resumable upload was not found");
    throw new Error(`resumable upload metadata is invalid: ${String(error?.message || error)}`);
  }
  if (session?.uploadId !== uploadId
    || session?.streamId !== streamId
    || !Number.isSafeInteger(session.sizeBytes)
    || session.sizeBytes <= 0
    || session.sizeBytes > MAX_UPLOAD_BYTES
    || typeof session.assetId !== "string"
    || !/^[a-f0-9-]{36}\.(?:ts|m2ts|mp4|mov|mkv)$/i.test(session.assetId)) {
    throw new Error("resumable upload metadata is invalid");
  }
  const stat = await fs.promises.stat(partPath).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  const offset = stat?.isFile() ? stat.size : 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > session.sizeBytes) {
    throw new Error("resumable upload has an invalid byte offset");
  }
  return { session, sourceDir, uploadDir, partPath, metaPath, offset };
}

/** Applies the standard resumable-upload offset response header. */
function sendUploadOffset(res, offset, status = 204) {
  res.set("Upload-Offset", String(offset));
  return res.status(status).end();
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
    bitRate: Number.isFinite(Number(firstVideo.bit_rate)) && Number(firstVideo.bit_rate) > 0 ? Number(firstVideo.bit_rate) : null,
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
      "-show_entries", "format=format_name,format_long_name,duration:stream=index,codec_type,codec_name,codec_long_name,codec_tag_string,codec_tag,width,height,sample_aspect_ratio,display_aspect_ratio,avg_frame_rate,r_frame_rate,profile,bit_rate:stream_tags",
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

/** Selects full-file warning classifiers from ffprobe's detected container. */
function resolveFileIntegrityProfile(inputUrl, containerName) {
  const formatName = String(containerName || "").toLowerCase();
  const extension = path.extname(String(inputUrl || "")).toLowerCase();
  if (formatName.includes("mpegts") || [".ts", ".m2ts"].includes(extension)) {
    return { id: "mpegts", label: "MPEG-TS", findings: [...TRANSPORT_INTEGRITY_FINDINGS, ...GENERIC_FILE_INTEGRITY_FINDINGS] };
  }
  if (formatName.includes("mov") || formatName.includes("mp4") || [".mp4", ".mov"].includes(extension)) {
    return { id: "mp4-mov", label: "MP4/MOV", findings: [...ISO_BASE_MEDIA_INTEGRITY_FINDINGS, ...GENERIC_FILE_INTEGRITY_FINDINGS] };
  }
  if (formatName.includes("matroska") || formatName.includes("webm") || [".mkv", ".webm"].includes(extension)) {
    return { id: "matroska", label: "MKV", findings: [...MATROSKA_INTEGRITY_FINDINGS, ...GENERIC_FILE_INTEGRITY_FINDINGS] };
  }
  return { id: "generic", label: "File", findings: GENERIC_FILE_INTEGRITY_FINDINGS };
}

/** Converts full-file FFprobe warnings into concise, stable UI findings. */
function summarizeFileIntegrityFindings(stderr, profile) {
  const text = String(stderr || "");
  return profile.findings
    .filter((finding) => finding.pattern.test(text))
    .map(({ code, message }) => ({ code, message }));
}

/**
 * Reads every demuxed packet without decoding or writing media. FFprobe may
 * exit successfully after recovering from damaged input, so stderr is
 * deliberately classified alongside the process exit status.
 */
function scanFileIntegrity(inputUrl, profile) {
  return new Promise((resolve) => {
    const startedAtMs = Date.now();
    const args = [
      "-hide_banner",
      "-v", "warning",
      "-count_packets",
      "-show_entries", "stream=index,codec_type,codec_name,nb_read_packets",
      "-of", "json",
      inputUrl
    ];
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        scanner: "ffprobe-count-packets",
        container: profile.id,
        containerLabel: profile.label,
        scannedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        ...result
      });
    };

    const proc = spawn(FFPROBE_BIN, args, { stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill("SIGKILL"); } catch {}
    }, FILE_INTEGRITY_SCAN_TIMEOUT_MS);

    proc.stderr.on("data", (chunk) => {
      if (stderr.length >= FILE_INTEGRITY_SCAN_STDERR_LIMIT) return;
      stderr += chunk.toString().slice(0, FILE_INTEGRITY_SCAN_STDERR_LIMIT - stderr.length);
    });
    proc.on("error", (error) => {
      finish({
        status: "unavailable",
        findings: [],
        error: String(error?.message || error)
      });
    });
    proc.on("close", (code, signal) => {
      if (timedOut) {
        finish({
          status: "unavailable",
          findings: [],
          error: `scan timed out after ${FILE_INTEGRITY_SCAN_TIMEOUT_MS}ms`
        });
        return;
      }

      const findings = summarizeFileIntegrityFindings(stderr, profile);
      if (code !== 0) {
        finish({
          status: findings.length ? "corrupt" : "unavailable",
          findings,
          error: findings.length ? null : (stderr.trim() || `ffprobe exited (code=${String(code)}, signal=${String(signal)})`)
        });
        return;
      }
      finish({ status: findings.length ? "corrupt" : "clean", findings, error: null });
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

/** Runs a full-file integrity scan without delaying media packaging. */
function queueFileIntegrityScan({ streamId, inputUrl, containerName, requestId }) {
  const profile = resolveFileIntegrityProfile(inputUrl, containerName);
  setSourceState(streamId, {
    integrity: {
      status: "scanning",
      scanner: "ffprobe-count-packets",
      container: profile.id,
      containerLabel: profile.label,
      findings: [],
      error: null,
      startedAt: new Date().toISOString()
    }
  });

  void scanFileIntegrity(inputUrl, profile)
    .then((integrity) => {
      const tracked = sourceStates.get(streamId);
      // A newer start may have replaced this source while its scan was running.
      if (!tracked || tracked.inputUrl !== inputUrl) return;
      setSourceState(streamId, { integrity });
      log[integrity.status === "corrupt" ? "warn" : "info"]("file_integrity_scan_complete", {
        requestId,
        streamId,
        status: integrity.status,
        findings: integrity.findings.map((finding) => finding.code),
        durationMs: integrity.durationMs,
        error: integrity.error
      });
    })
    .catch((error) => {
      const tracked = sourceStates.get(streamId);
      if (!tracked || tracked.inputUrl !== inputUrl) return;
      const integrity = {
        status: "unavailable",
        scanner: "ffprobe-count-packets",
        container: profile.id,
        containerLabel: profile.label,
        findings: [],
        error: String(error?.message || error),
        scannedAt: new Date().toISOString()
      };
      setSourceState(streamId, { integrity });
      log.warn("file_integrity_scan_error", { requestId, streamId, error: serializeError(error) });
    });
}

/** Returns the current public state object for a source. */
function currentSourceState(streamId) {
  const tracked = sourceStates.get(streamId);
  if (tracked?.state) return tracked.state;
  if (sources.has(streamId)) return "running";
  return "stopped";
}

/** Deletes generated artifacts while preserving authoritative uploaded source files. */
async function purgeSourceArtifacts(streamId) {
  const outDir = resolveStreamRecordingDir(streamId);
  const sourceDir = resolveSourceAssetDir(streamId);
  const sdpFile = path.join(DB_DIR, `${streamId}.sdp`);

  await fs.promises.mkdir(outDir, { recursive: true });
  const entries = await fs.promises.readdir(outDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  await Promise.all(entries
    .filter((entry) => entry.name !== SOURCE_ASSET_DIRNAME)
    .map((entry) => fs.promises.rm(path.join(outDir, entry.name), { recursive: true, force: true })));
  await fs.promises.mkdir(sourceDir, { recursive: true });
  try { await fs.promises.rm(sdpFile, { force: true }); } catch {}

  const deletedEvents = await store.purgeStream(streamId);
  return { outDir, sdpFile, deletedEvents };
}

/**
 * Returns the exact file-backed clip boundary that browser HLS can currently
 * serve. Do not substitute FFmpeg's processed time: it can lead the last
 * playlist entry while a segment is still being written.
 */
function getFileClipAvailability(streamId, source, tracked) {
  if (source?.sourceType !== "file") {
    return { availableClipEndSeconds: null, availableClipSegmentCount: null };
  }
  const durationSeconds = Number(tracked?.durationSeconds);
  if (tracked?.state === "ready" && Number.isFinite(durationSeconds) && durationSeconds > 0) {
    return { availableClipEndSeconds: durationSeconds, availableClipSegmentCount: null };
  }
  // An ABR viewer may be on any browser rendition. Use the earliest completed
  // end across them so a High playlist cannot lag behind a clip marker that
  // was calculated from Low. The private carrier playlist is not included.
  const playlistNames = [...new Set((source.hlsRenditions || source.hls?.renditions || [])
    .map((rendition) => String(rendition?.playlist || "").trim())
    .filter(Boolean))];
  if (!playlistNames.length) playlistNames.push("v0/index.m3u8");
  const availabilities = playlistNames.map((playlistName) => readCompletedHlsPlaylistAvailability({
    outDir: resolveStreamRecordingDir(streamId),
    playlistName
  }));
  const availability = availabilities.reduce((earliest, candidate) => (
    candidate.endSeconds < earliest.endSeconds ? candidate : earliest
  ));
  return {
    availableClipEndSeconds: availability.endSeconds,
    availableClipSegmentCount: availability.segmentCount
  };
}

/** Clears one stream completely before a new Start Source workflow begins. */
async function resetSourceArtifacts(streamId) {
  const outDir = resolveStreamRecordingDir(streamId);
  const sdpFile = path.join(DB_DIR, `${streamId}.sdp`);

  await fs.promises.rm(outDir, { recursive: true, force: true });
  await fs.promises.rm(sdpFile, { force: true });
  // Both methods use BEGIN IMMEDIATE on the shared SQLite connection. They
  // must be serialized; concurrent transactions cause SQLITE_ERROR: cannot
  // start a transaction within a transaction.
  const deletedEvents = await store.purgeStream(streamId);
  const deletedTargetLog = await store.purgeTargetLog(streamId);
  return { outDir, sdpFile, deletedEvents, deletedTargetLog };
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
      klvProcessingRequired: tracked?.klvProcessingRequired !== false,
      klvTelemetryEventCount: tracked?.klvTelemetryEventCount ?? null,
      sourceVideo: tracked?.sourceVideo || null,
      integrity: tracked?.integrity || null,
      stage: tracked?.stage || null,
      durationSeconds: tracked?.durationSeconds ?? null,
      availableClipEndSeconds: tracked?.availableClipEndSeconds ?? null,
      availableClipSegmentCount: tracked?.availableClipSegmentCount ?? null,
      processedSeconds: tracked?.processedSeconds ?? null,
      progressPercent: tracked?.progressPercent ?? null,
      encodeSpeed: tracked?.encodeSpeed ?? null,
      etaSeconds: tracked?.etaSeconds ?? null,
      finalizationProgressPercent: tracked?.finalizationProgressPercent ?? null,
      finalizationProcessedSegments: tracked?.finalizationProcessedSegments ?? null,
      finalizationTotalSegments: tracked?.finalizationTotalSegments ?? null,
      finalizationEtaSeconds: tracked?.finalizationEtaSeconds ?? null,
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
  } else if (hlsRunning && (source.klvProcessingRequired === false || klvRunning) && (source.sourceType === "file" || ingestRunning)) {
    state = "running";
  } else if (hlsRunning) {
    state = "degraded";
  } else if (state !== "starting" && state !== "stopping") {
    state = "error";
  }
  const clipAvailability = getFileClipAvailability(streamId, source, tracked);

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
    klvProcessingRequired: source.klvProcessingRequired !== false,
    klvTelemetryEventCount: tracked?.klvTelemetryEventCount ?? null,
    sourceVideo: source.sourceVideo || tracked?.sourceVideo || null,
    integrity: tracked?.integrity || null,
    stage: tracked?.stage || null,
    durationSeconds: tracked?.durationSeconds ?? null,
    ...clipAvailability,
    processedSeconds: tracked?.processedSeconds ?? null,
    progressPercent: tracked?.progressPercent ?? null,
    encodeSpeed: tracked?.encodeSpeed ?? null,
    etaSeconds: tracked?.etaSeconds ?? null,
    finalizationProgressPercent: tracked?.finalizationProgressPercent ?? null,
    finalizationProcessedSegments: tracked?.finalizationProcessedSegments ?? null,
    finalizationTotalSegments: tracked?.finalizationTotalSegments ?? null,
    finalizationEtaSeconds: tracked?.finalizationEtaSeconds ?? null,
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
      // JPEG viewers are inconsistent about honoring a non-square SAR. Bake
      // the input DAR into the output dimensions and make the poster square-pixel.
      "-vf", `scale=${SOURCE_POSTER_WIDTH}:trunc(${SOURCE_POSTER_WIDTH}/dar/2)*2,setsar=1/1`,
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
app.get("/openapi.yaml", (_req, res) => {
  res.type("application/yaml").sendFile(path.resolve("./openapi.yaml"));
});
app.get("/docs", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Midas API documentation</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>window.ui = SwaggerUIBundle({ url: '/openapi.yaml', dom_id: '#swagger-ui', deepLinking: true });</script>
</body></html>`);
});
// Authoritative uploads live beside generated HLS artifacts, but must remain
// private: they are accessed only by the file-source, clip, and snapshot APIs.
app.use("/hls/:streamId/source", (_req, res) => {
  res.status(404).type("text/plain").send("source asset is not publicly served");
});
// FFmpeg atomically replaces live HLS playlists by renaming index.m3u8.tmp.
// On Windows, a streamed static-file response can keep index.m3u8 open long
// enough to block that rename. Playlists are small, so read them fully and
// close the filesystem handle before writing the HTTP response. Media segments
// remain served by express.static below and are never buffered in memory.
app.get("/hls/*", async (req, res, next) => {
  const relativePath = String(req.params[0] || "");
  if (!/\.m3u8$/i.test(relativePath)) return next();

  const playlistPath = path.resolve(RECORD_ROOT, relativePath);
  const relativeToRoot = path.relative(RECORD_ROOT, playlistPath);
  if (!relativeToRoot || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
    return res.status(403).type("text/plain").send("invalid HLS playlist path");
  }

  try {
    const playlist = await fs.promises.readFile(playlistPath);
    res
      .type("application/vnd.apple.mpegurl; charset=utf-8")
      .set("Access-Control-Allow-Origin", "*")
      .set("Cache-Control", "no-cache")
      .send(playlist);
  } catch (error) {
    if (error?.code === "ENOENT") return next();
    log.warn("hls_playlist_read_error", { path: relativePath, error: serializeError(error) });
    return res.status(500).type("text/plain").send("unable to read HLS playlist");
  }
});
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
// Resumable uploads are persisted below each stream's source/ directory so the
// browser can continue a large upload after a network interruption or reload.
app.post("/uploads/video/resumable", async (req, res) => {
  const streamId = String(req.body?.streamId || "").trim();
  const uploadName = String(req.body?.filename || "").trim();
  const extension = path.extname(uploadName).toLowerCase();
  const sizeBytes = Number(req.body?.sizeBytes);
  if (!VIDEO_UPLOAD_EXTENSIONS.has(extension)) {
    return res.status(400).json({ ok: false, error: "supported video extensions: .ts, .m2ts, .mp4, .mov, .mkv" });
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ ok: false, error: `video must be between 1 byte and ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB` });
  }

  const uploadId = randomUUID();
  const assetId = `${randomUUID()}${extension}`;
  let paths;
  try {
    paths = resumableUploadPaths(streamId, uploadId);
    await fs.promises.mkdir(paths.uploadDir, { recursive: true });
  } catch (error) {
    return res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
  const session = {
    uploadId,
    streamId,
    assetId,
    uploadName: path.basename(uploadName),
    sizeBytes,
    createdAt: new Date().toISOString()
  };
  try {
    await fs.promises.writeFile(paths.metaPath, JSON.stringify(session), { encoding: "utf8", flag: "wx" });
    log.info("resumable_upload_created", { requestId: req.requestId, streamId, uploadId, assetId, sizeBytes });
    return res.status(201).json({
      ok: true,
      uploadId,
      offset: 0,
      uploadUrl: `/uploads/video/resumable/${encodeURIComponent(streamId)}/${uploadId}`
    });
  } catch (error) {
    log.warn("resumable_upload_create_error", { requestId: req.requestId, error: serializeError(error) });
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

// Drives the Local server file picker. Only configured-root contents are sent
// to the browser; the copy endpoint independently validates each selection.
app.get("/uploads/video/local-files", async (req, res) => {
  try {
    const files = await listLocalServerVideos();
    return res.json({ ok: true, files });
  } catch (error) {
    log.warn("local_video_list_error", { requestId: req.requestId, error: serializeError(error) });
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

// Copies a server-local video into the same authoritative source location used
// by browser uploads, avoiding an HTTP transfer through the browser.
app.post("/uploads/video/local-copy", async (req, res) => {
  const streamId = String(req.body?.streamId || "").trim();
  const inputPath = typeof req.body?.inputPath === "string" ? req.body.inputPath : "";
  try {
    const copied = await copyLocalServerVideo(streamId, inputPath);
    log.info("local_video_copy_complete", {
      requestId: req.requestId,
      streamId,
      assetId: copied.assetId,
      sourceFilename: copied.sourceFilename,
      sizeBytes: copied.sizeBytes
    });
    return res.status(201).json({ ok: true, ...copied });
  } catch (error) {
    log.warn("local_video_copy_error", { requestId: req.requestId, streamId, error: serializeError(error) });
    return res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

// The browser calls this first on every Start Source action. File uploads then
// land in a fresh source/ directory; live sources proceed directly to startup.
app.post("/sources/:streamId/reset", async (req, res) => {
  const streamId = req.params.streamId;
  const state = currentSourceState(streamId);
  if (sources.has(streamId) || ["starting", "running", "degraded", "stopping", "finalizing", "ready"].includes(state)) {
    return res.status(409).json({
      ok: false,
      error: `source ${streamId} is currently ${state}; stop it before starting again`,
      state: getSourceRuntime(streamId)
    });
  }
  try {
    const reset = await resetSourceArtifacts(streamId);
    log.info("source_reset_complete", { streamId, deletedEvents: reset.deletedEvents, outDir: reset.outDir });
    return res.json({ ok: true, deletedEvents: reset.deletedEvents });
  } catch (error) {
    log.warn("source_reset_error", { streamId, error: serializeError(error) });
    return res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.head("/uploads/video/resumable/:streamId/:uploadId", async (req, res) => {
  try {
    const { offset } = await loadResumableUpload(req.params.streamId, req.params.uploadId);
    return sendUploadOffset(res, offset);
  } catch (error) {
    return res.status(404).end();
  }
});

app.patch("/uploads/video/resumable/:streamId/:uploadId", async (req, res) => {
  const uploadId = req.params.uploadId;
  let loaded;
  try {
    loaded = await loadResumableUpload(req.params.streamId, uploadId);
  } catch (error) {
    return res.status(404).json({ ok: false, error: String(error?.message || error) });
  }

  const expectedOffset = Number(req.headers["upload-offset"]);
  if (!Number.isSafeInteger(expectedOffset) || expectedOffset < 0) {
    return res.status(400).json({ ok: false, error: "Upload-Offset must be a non-negative integer" });
  }
  if (expectedOffset !== loaded.offset) {
    res.set("Upload-Offset", String(loaded.offset));
    return res.status(409).json({ ok: false, error: "upload offset does not match server state" });
  }
  if (activeResumableUploads.has(uploadId)) {
    res.set("Upload-Offset", String(loaded.offset));
    return res.status(409).json({ ok: false, error: "upload is already writing" });
  }

  const remainingBytes = loaded.session.sizeBytes - loaded.offset;
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && (declaredLength < 0 || declaredLength > remainingBytes)) {
    return res.status(413).json({ ok: false, error: "upload chunk exceeds the remaining file size" });
  }

  activeResumableUploads.add(uploadId);
  let receivedBytes = 0;
  const byteLimit = new Transform({
    transform(chunk, _encoding, callback) {
      if (receivedBytes + chunk.length > remainingBytes) {
        const error = new Error("upload chunk exceeds the remaining file size");
        error.code = "UPLOAD_SIZE_LIMIT";
        callback(error);
        return;
      }
      receivedBytes += chunk.length;
      callback(null, chunk);
    }
  });

  try {
    await pipeline(req, byteLimit, fs.createWriteStream(loaded.partPath, { flags: "a" }));
    const nextOffset = loaded.offset + receivedBytes;
    log.debug("resumable_upload_chunk_complete", { requestId: req.requestId, uploadId, receivedBytes, nextOffset });
    return sendUploadOffset(res, nextOffset);
  } catch (error) {
    const current = await loadResumableUpload(req.params.streamId, uploadId).catch(() => ({ offset: loaded.offset }));
    res.set("Upload-Offset", String(current.offset));
    const status = error?.code === "UPLOAD_SIZE_LIMIT" ? 413 : 500;
    log.warn("resumable_upload_chunk_error", { requestId: req.requestId, uploadId, error: serializeError(error) });
    return res.status(status).json({ ok: false, error: String(error?.message || error) });
  } finally {
    activeResumableUploads.delete(uploadId);
  }
});

app.post("/uploads/video/resumable/:streamId/:uploadId/complete", async (req, res) => {
  const uploadId = req.params.uploadId;
  if (activeResumableUploads.has(uploadId)) {
    return res.status(409).json({ ok: false, error: "upload is still writing" });
  }
  let loaded;
  try {
    loaded = await loadResumableUpload(req.params.streamId, uploadId);
  } catch (error) {
    return res.status(404).json({ ok: false, error: String(error?.message || error) });
  }
  if (loaded.offset !== loaded.session.sizeBytes) {
    res.set("Upload-Offset", String(loaded.offset));
    return res.status(409).json({ ok: false, error: "upload is incomplete" });
  }

  const destinationPath = path.join(loaded.sourceDir, loaded.session.assetId);
  try {
    await fs.promises.rename(loaded.partPath, destinationPath);
    await fs.promises.rm(loaded.metaPath, { force: true });
    log.info("resumable_upload_complete", {
      requestId: req.requestId,
      uploadId,
      assetId: loaded.session.assetId,
      receivedBytes: loaded.offset
    });
    return res.status(201).json({ ok: true, assetId: loaded.session.assetId, sizeBytes: loaded.offset });
  } catch (error) {
    log.warn("resumable_upload_complete_error", { requestId: req.requestId, uploadId, error: serializeError(error) });
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/uploads/video", async (req, res) => {
  const streamId = String(req.headers["x-upload-stream-id"] || "").trim();
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
  let sourceDir;
  try {
    sourceDir = resolveSourceAssetDir(streamId);
    await fs.promises.mkdir(sourceDir, { recursive: true });
  } catch (error) {
    return res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
  const temporaryPath = path.join(sourceDir, `${assetId}.upload`);
  const destinationPath = path.join(sourceDir, assetId);
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
    log.info("video_upload_complete", { requestId: req.requestId, streamId, assetId, receivedBytes });
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

/** Builds and caches a real filmstrip of representative authoritative frames. */
async function getClipThumbnailFrames(streamId, source, durationSeconds) {
  const sourceDir = resolveSourceAssetDir(streamId);
  const sourceInputPath = path.resolve(String(source.inputUrl || ""));
  if (!sourceInputPath.startsWith(`${sourceDir}${path.sep}`) || !fs.existsSync(sourceInputPath)) {
    throw new Error("uploaded source file is unavailable");
  }

  const assetKey = path.parse(sourceInputPath).name;
  const thumbnailDir = path.join(resolveStreamRecordingDir(streamId), "clip-thumbnails", assetKey);
  const filename = "filmstrip.jpg";
  const thumbnailPath = path.join(thumbnailDir, filename);
  const thumbnailUrl = `/sources/${encodeURIComponent(streamId)}/clip-thumbnails/${encodeURIComponent(assetKey)}/${filename}`;
  const jobKey = `${streamId}:${assetKey}:${durationSeconds.toFixed(3)}`;

  if (fs.existsSync(thumbnailPath)) {
    return [{ url: thumbnailUrl }];
  }
  if (clipThumbnailJobs.has(jobKey)) return clipThumbnailJobs.get(jobKey);

  const job = (async () => {
    await fs.promises.rm(thumbnailDir, { recursive: true, force: true });
    await fs.promises.mkdir(thumbnailDir, { recursive: true });
    try {
      const times = Array.from({ length: CLIP_THUMBNAIL_COUNT }, (_, index) =>
        Number((durationSeconds * ((index + 0.5) / CLIP_THUMBNAIL_COUNT)).toFixed(3))
      );
      const filterInputs = times.map((_, index) =>
        `[${index}:v:0]scale=${CLIP_THUMBNAIL_WIDTH}:trunc(${CLIP_THUMBNAIL_WIDTH}/dar/2)*2,setsar=1/1[thumb${index}]`
      ).join(";");
      const hstackInputs = times.map((_, index) => `[thumb${index}]`).join("");
      await runFfmpeg([
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        // Each input seeks independently, so the overview stays fast for a
        // multi-hour TS rather than decoding the entire carrier. Seek accuracy
        // is retained so H.264 parameter sets are decoded before each still;
        // malformed TS packets are discarded just as they are during file-source
        // HLS packaging.
        ...times.flatMap((timeSeconds) => [
          "-ss", String(timeSeconds),
          "-fflags", "+genpts+discardcorrupt",
          "-err_detect", "ignore_err",
          "-i", sourceInputPath
        ]),
        "-filter_complex", `${filterInputs};${hstackInputs}hstack=inputs=${CLIP_THUMBNAIL_COUNT}[filmstrip]`,
        "-map", "[filmstrip]",
        "-frames:v", "1",
        "-q:v", "4",
        thumbnailPath
      ], { label: "clip filmstrip capture", timeoutMs: CLIP_THUMBNAIL_TIMEOUT_MS });
      const generated = await fs.promises.stat(thumbnailPath).catch(() => null);
      if (!generated?.isFile() || generated.size <= 0) throw new Error("clip filmstrip generation produced no image");
      log.info("clip_thumbnails_ready", { streamId, assetKey, count: CLIP_THUMBNAIL_COUNT });
      return [{ url: thumbnailUrl }];
    } catch (error) {
      await fs.promises.rm(thumbnailDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  })();
  clipThumbnailJobs.set(jobKey, job);
  try {
    return await job;
  } finally {
    clipThumbnailJobs.delete(jobKey);
  }
}

// Real thumbnail frames are generated lazily and cached with the stream's
// recording artifacts. They are cleared automatically on the next start.
app.get("/sources/:streamId/clip-thumbnails", async (req, res) => {
  const streamId = req.params.streamId;
  const source = sources.get(streamId);
  if (!source || source.sourceType !== "file") {
    return res.status(409).json({ ok: false, error: "clip thumbnails are available only for an uploaded video source" });
  }
  const durationSeconds = Number(sourceStates.get(streamId)?.durationSeconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return res.status(409).json({ ok: false, error: "video duration is not available yet" });
  }
  try {
    const thumbnails = await getClipThumbnailFrames(streamId, source, durationSeconds);
    return res.json({ ok: true, thumbnails });
  } catch (error) {
    log.warn("clip_thumbnails_error", { streamId, error: serializeError(error) });
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

// Serve only a current source's generated thumbnail frame, never a source file.
app.get("/sources/:streamId/clip-thumbnails/:assetKey/:filename", async (req, res) => {
  const { streamId, assetKey, filename } = req.params;
  const source = sources.get(streamId);
  if (!source || source.sourceType !== "file" || !/^[a-f0-9-]{36}$/i.test(assetKey) || filename !== "filmstrip.jpg") {
    return res.status(404).end();
  }
  const currentAssetKey = path.parse(path.resolve(String(source.inputUrl || ""))).name;
  if (assetKey !== currentAssetKey) return res.status(404).end();
  try {
    const thumbnailDir = path.resolve(resolveStreamRecordingDir(streamId), "clip-thumbnails", assetKey);
    const filePath = path.resolve(thumbnailDir, filename);
    if (!filePath.startsWith(`${thumbnailDir}${path.sep}`) || !fs.existsSync(filePath)) return res.status(404).end();
    return res.sendFile(filePath);
  } catch {
    return res.status(404).end();
  }
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
    const sourceDir = resolveSourceAssetDir(streamId);
    sourceInputPath = path.resolve(String(source.inputUrl || ""));
    if (!sourceInputPath.startsWith(`${sourceDir}${path.sep}`) || !fs.existsSync(sourceInputPath)) {
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

  const sourceDir = resolveSourceAssetDir(streamId);
  const sourceInputPath = path.resolve(String(source.inputUrl || ""));
  if (!sourceInputPath.startsWith(`${sourceDir}${path.sep}`) || !fs.existsSync(sourceInputPath)) {
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
      // Input seeking avoids decoding a multi-hour authoritative TS from its
      // beginning. FFmpeg selects the nearest decodable keyframe at or before
      // the requested playback time.
      "-ss", String(normalizedTimeSeconds),
      "-i", sourceInputPath,
      "-map", "0:v:0",
      "-frames:v", "1",
      // A still image should be square-pixel, so expand a 1440×1080 frame
      // with 4:3 SAR to its 1920×1080 display geometry before JPEG encoding.
      "-vf", "scale=trunc(ih*dar/2)*2:ih,setsar=1/1",
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
  let purgeResult;

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

  // Variable-rate VTT tuning
  maxCuesPerSecond = 10,
  minCueDurSec = 0.10,
  maxCueDurSec = 0.50
} = req.body || {};
    sourceType = normalizeSourceType(requestedSourceType);
    const hlsMode = normalizeHlsMode(requestedHlsMode);
    const webRtcMode = normalizeWebRtcMode(requestedWebRtcMode);
    const resolvedInputUrl = sourceType === "file"
      ? resolveUploadedVideo(streamId, assetId)
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
    // A short TS probe can see the video stream before its next decodable
    // header. Retry with a fuller ffprobe pass whenever dimensions are absent.
    // File probes omit `-read_intervals` so ffprobe can reach the first video
    // headers even when a TS begins mid-GOP; live probes stay time-bounded.
    if (!hasVideoDimensions(sourceProbe)) {
      try {
        const dimensionProbe = await probeInputWithFfprobe(resolvedInputUrl, {
          timeoutMs: LIVE_DIMENSION_PROBE_TIMEOUT_MS,
          analyzeDurationUs: 10_000_000,
          probeSizeBytes: 32_000_000,
          readInterval: sourceType === "file" ? null : "%+10"
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
    if (hlsEncoderMode !== "copy-h264" && !hasVideoDimensions(sourceProbe)) {
      throw new Error("unable to determine source video dimensions with ffprobe; ABR/transcode HLS will not start without a native High resolution");
    }
    const webRtcEncoderMode = sourceType === "file"
      ? null
      : resolveWebRtcEncodeMode(webRtcMode, sourceProbe);
    const mode = hlsEncoderMode;
    const effectiveSegmentSeconds = normalizeSegmentSeconds(
      hlsSegmentSeconds,
      normalizeSegmentSeconds(vttSegmentSeconds, 1)
    );
    // A confirmed no-KLV file has no telemetry sidecar to decode or finalize.
    // An absent/failed probe remains conservative and takes the normal KLV path.
    const klvProcessingRequired = sourceType !== "file" || sourceProbe?.klv?.available !== false;
    const fileIntegrityProfile = sourceType === "file"
      ? resolveFileIntegrityProfile(resolvedInputUrl, sourceProbe?.container?.name)
      : null;

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
      klvProcessingRequired,
      klvTelemetryEventCount: klvProcessingRequired ? null : 0,
      sourceVideo: sourceProbe?.video || null,
      integrity: sourceType === "file"
        ? {
          status: "pending",
          scanner: "ffprobe-count-packets",
          container: fileIntegrityProfile.id,
          containerLabel: fileIntegrityProfile.label,
          findings: [],
          error: null
        }
        : null,
      durationSeconds: fileDurationSeconds,
      availableClipEndSeconds: sourceType === "file" ? 0 : null,
      availableClipSegmentCount: sourceType === "file" ? 0 : null,
      processedSeconds: sourceType === "file" ? 0 : null,
      progressPercent: sourceType === "file" ? 0 : null,
      encodeSpeed: null,
      etaSeconds: null,
      finalizationProgressPercent: null,
      finalizationProcessedSegments: null,
      finalizationTotalSegments: null,
      finalizationEtaSeconds: null,
      stage: "initializing",
      lastError: null
    });

    // Starts received outside the UI still clear generated artifacts. The
    // source/ directory is retained here because it holds the selected file.
    setSourceState(streamId, { state: "starting", stage: "purging" });
    purgeResult = await purgeSourceArtifacts(streamId);
    log.info("source_purge_complete", {
      streamId,
      deletedEvents: purgeResult.deletedEvents,
      outDir: purgeResult.outDir
    });

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
      purgeBeforeStart: true
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
    if (klvProcessingRequired) {
      await bootstrapSubtitleArtifacts(outDir, effectiveSegmentSeconds);
    }
    await fs.promises.writeFile(
      masterPath,
      hls.isAbr
        ? createHlsMasterPlaylist(hls.renditions, { includeSubtitles: klvProcessingRequired })
        : createPassthroughHlsMasterPlaylist({ includeSubtitles: klvProcessingRequired })
    );

    // 2) KLV ingest + DB/VTT sidecar in dedicated worker process
    if (klvProcessingRequired) klvWorker = await startKlvStreamWorker({
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
      onFinalizationProgress: ({ processedSegments, totalSegments, progressPercent, etaSeconds }) => {
        const tracked = sourceStates.get(streamId);
        if (!tracked || tracked.state !== "finalizing") return;
        setSourceState(streamId, {
          finalizationProcessedSegments: Math.max(0, Number(processedSegments) || 0),
          finalizationTotalSegments: Math.max(0, Number(totalSegments) || 0),
          finalizationProgressPercent: Math.max(0, Math.min(100, Number(progressPercent) || 0)),
          finalizationEtaSeconds: Math.max(0, Number(etaSeconds) || 0)
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
    setSourceState(streamId, {
      state: "starting",
      stage: klvProcessingRequired ? "klv_started" : "klv_skipped_no_data"
    });

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
      klvProcessingRequired,
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
      if (source.fileCompletionStarted) return;
      source.fileCompletionStarted = true;
      if (!source.klvProcessingRequired) {
        setSourceState(streamId, {
          state: "ready",
          running: false,
          ingestRunning: false,
          stage: null,
          progressPercent: 100,
          etaSeconds: 0,
          finalizationProgressPercent: null,
          finalizationProcessedSegments: null,
          finalizationTotalSegments: null,
          finalizationEtaSeconds: null,
          klvTelemetryEventCount: 0,
          lastError: null
        });
        log.info("file_source_ready_no_klv", { streamId });
        return;
      }
      setSourceState(streamId, {
        state: "finalizing",
        running: false,
        ingestRunning: false,
        stage: "finalizing_vtt",
        finalizationProgressPercent: 0,
        finalizationProcessedSegments: 0,
        finalizationTotalSegments: null,
        finalizationEtaSeconds: null
      });
      try {
        const finalizeTimeoutMs = estimateKlvFinalizeTimeoutMs(
          sourceStates.get(streamId)?.durationSeconds,
          source.hlsSegmentSeconds
        );
        log.info("file_klv_finalization_start", { streamId, finalizeTimeoutMs });
        await finalizeKlvStreamWorker(source.klvWorker, { timeoutMs: finalizeTimeoutMs });
        await stopKlvStreamWorker(source.klvWorker);
        source.klvWorker = null;
        let missionData = null;
        try {
          missionData = await store.getMissionDataSummary(streamId);
          log.info("file_source_ready_sqlite_mission_data", {
            streamId,
            // KML exports are built only from these persisted KLV rows.
            kmlTelemetryEventCount: missionData.klvEventCount,
            firstMissionTimeMs: missionData.firstMissionTimeMs,
            lastMissionTimeMs: missionData.lastMissionTimeMs,
            targetLogEntryCount: missionData.targetLogEntryCount,
            activeTargetLogFieldCount: missionData.activeTargetLogFieldCount
          });
        } catch (error) {
          // Readiness must not be downgraded if the diagnostic count fails.
          log.warn("file_source_ready_sqlite_mission_data_error", {
            streamId,
            error: serializeError(error)
          });
        }
        setSourceState(streamId, {
          state: "ready",
          running: false,
          ingestRunning: false,
          stage: null,
          progressPercent: 100,
          etaSeconds: 0,
          finalizationProgressPercent: 100,
          finalizationEtaSeconds: 0,
          klvTelemetryEventCount: missionData?.klvEventCount ?? null,
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
    klvWorker?.proc?.once("exit", (code, signal) => onWorkerExit("klv_worker", code, signal));

    setSourceState(streamId, {
      state: "running",
      running: true,
      stage: null,
      ingestRunning: sourceType !== "file",
      lastError: null
    });

    if (sourceType === "file") {
      queueFileIntegrityScan({
        streamId,
        inputUrl: resolvedInputUrl,
        containerName: sourceProbe?.container?.name,
        requestId: req.requestId
      });
    }

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
        enabled: true,
        deletedEvents: purgeResult.deletedEvents
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
  const deletedTargetLog = await store.purgeTargetLog(streamId);

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
  log.info("source_delete_success", { streamId, deletedTargetLog });
  res.json({ ok: true, deletedTargetLog });
});

// ---------- API: direct KLV query ----------
const KLV_CSV_COLUMNS = [
  "stream_id", "mission_time_utc", "mission_time_unix_ms", "video_time_seconds", "timestamp_source", "mission_id",
  "platform_tail_number", "platform_designation", "platform_call_sign", "image_source_sensor", "image_coordinate_system",
  "platform_true_airspeed_mps", "platform_indicated_airspeed_mps", "platform_ground_speed_mps",
  "sensor_latitude", "sensor_longitude", "sensor_alt_msl_m",
  "platform_heading_deg", "platform_pitch_deg", "platform_roll_deg",
  "frame_center_latitude", "frame_center_longitude", "frame_center_elevation_msl_m",
  "sensor_relative_azimuth_deg", "sensor_relative_elevation_deg", "sensor_relative_roll_deg",
  "sensor_horizontal_fov_deg", "sensor_vertical_fov_deg", "slant_range_m",
  "target_width_m", "target_latitude", "target_longitude", "target_elevation_msl_m",
  "target_track_gate_width_px", "target_track_gate_height_px", "target_location_ce90_m", "target_location_le90_m",
  "icing_detected_code", "wind_direction_deg", "wind_speed_mps", "static_pressure_mbar", "differential_pressure_mbar",
  "density_altitude_m", "outside_air_temperature_c", "airfield_barometric_pressure_mbar", "airfield_elevation_m",
  "relative_humidity_percent", "platform_angle_of_attack_deg", "platform_vertical_speed_mps",
  "platform_sideslip_angle_deg", "platform_fuel_remaining_kg",
  "frame_corner_1_latitude", "frame_corner_1_longitude", "frame_corner_2_latitude", "frame_corner_2_longitude",
  "frame_corner_3_latitude", "frame_corner_3_longitude", "frame_corner_4_latitude", "frame_corner_4_longitude",
  "frame_corner_source"
];

function csvCell(value) {
  if (value === undefined || value === null) return "";
  let text = typeof value === "string" ? value : String(value);
  // Prevent spreadsheet applications from interpreting textual metadata as a
  // formula. Numeric telemetry is passed as numbers and remains numeric.
  if (typeof value === "string" && /^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function csvMissionTimeIso(milliseconds) {
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value < 0) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function klvCsvRow(streamId, event, timeline) {
  const data = event.data || {};
  const missionTimeMs = Number(event.tMs);
  const videoTimeMs = timeline
    && missionTimeMs >= timeline.missionMinMs
    && missionTimeMs <= timeline.missionMaxMs
    ? Math.round(timeline.videoBaseMs + (missionTimeMs - timeline.missionBaseMs))
    : null;
  return [
    streamId, data.timestampIso || csvMissionTimeIso(missionTimeMs), missionTimeMs,
    Number.isFinite(videoTimeMs) && videoTimeMs >= 0 ? videoTimeMs / 1000 : null,
    data.timestampUnixMicros ? "klv" : "ingest", data.missionId,
    data.platformTailNumber, data.platformDesignation, data.platformCallSign, data.imageSourceSensor, data.imageCoordinateSystem,
    data.platformTrueAirspeedMps, data.platformIndicatedAirspeedMps, data.platformGroundSpeedMps,
    data.sensorLat, data.sensorLon, data.sensorAltMslM,
    data.platformHeadingDeg, data.platformPitchDeg, data.platformRollDeg,
    data.frameCenterLat, data.frameCenterLon, data.frameCenterElevationMslM,
    data.sensorRelAzDeg, data.sensorRelElDeg, data.sensorRelRollDeg,
    data.sensorHfovDeg, data.sensorVfovDeg, data.slantRangeM,
    data.targetWidthM, data.targetLat, data.targetLon, data.targetElevationMslM,
    data.targetTrackGateWidthPx, data.targetTrackGateHeightPx, data.targetLocationCe90M, data.targetLocationLe90M,
    data.icingDetectedCode, data.windDirectionDeg, data.windSpeedMps, data.staticPressureMbar, data.differentialPressureMbar,
    data.densityAltitudeM, data.outsideAirTemperatureC, data.airfieldBarometricPressureMbar, data.airfieldElevationM,
    data.relativeHumidityPercent, data.platformAngleOfAttackDeg, data.platformVerticalSpeedMps,
    data.platformSideslipAngleDeg, data.platformFuelRemainingKg,
    data.frameCorner1Lat, data.frameCorner1Lon, data.frameCorner2Lat, data.frameCorner2Lon,
    data.frameCorner3Lat, data.frameCorner3Lon, data.frameCorner4Lat, data.frameCorner4Lon,
    data.frameCornerSource
  ].map(csvCell).join(",");
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Keep the analytical fields that describe the sensor pointing solution on the
// SPI track, without duplicating them on platform and target location tracks.
const KML_TRACK_METADATA_FIELDS = [
  ["mission_time_utc", "Mission time (UTC)", (event) => kmlTime(event)],
  ["sensor_relative_azimuth_deg", "Sensor relative azimuth (deg)", (event) => event.sensorRelAzDeg],
  ["sensor_relative_elevation_deg", "Sensor relative elevation (deg)", (event) => event.sensorRelElDeg],
  ["sensor_relative_roll_deg", "Sensor relative roll (deg)", (event) => event.sensorRelRollDeg],
  ["sensor_horizontal_fov_deg", "Sensor horizontal FOV (deg)", (event) => event.sensorHfovDeg],
  ["sensor_vertical_fov_deg", "Sensor vertical FOV (deg)", (event) => event.sensorVfovDeg],
  ["slant_range_m", "Slant range (m)", (event) => event.slantRangeM],
  ["target_width_m", "Target width (m)", (event) => event.targetWidthM],
  ["target_latitude", "Target latitude (deg)", (event) => event.targetLat],
  ["target_longitude", "Target longitude (deg)", (event) => event.targetLon],
  ["target_elevation_msl_m", "Target elevation MSL (m)", (event) => event.targetElevationMslM],
  ["target_track_gate_width_px", "Target track-gate width (px)", (event) => event.targetTrackGateWidthPx],
  ["target_track_gate_height_px", "Target track-gate height (px)", (event) => event.targetTrackGateHeightPx],
  ["target_location_ce90_m", "Target-location CE90 (m)", (event) => event.targetLocationCe90M],
  ["target_location_le90_m", "Target-location LE90 (m)", (event) => event.targetLocationLe90M]
];

function validKmlPosition(lat, lon) {
  const hasLatitude = lat !== null && lat !== undefined && String(lat).trim() !== "";
  const hasLongitude = lon !== null && lon !== undefined && String(lon).trim() !== "";
  return hasLatitude
    && hasLongitude
    && Number.isFinite(Number(lat))
    && Number.isFinite(Number(lon))
    && Math.abs(Number(lat)) <= 90
    && Math.abs(Number(lon)) <= 180;
}

function kmlTime(event) {
  const preferred = String(event.timestampIso || "").trim();
  const preferredMs = Date.parse(preferred);
  if (preferred && Number.isFinite(preferredMs)) return new Date(preferredMs).toISOString();
  return csvMissionTimeIso(event.tMs);
}

function kmlTrack({ name, description, styleUrl, events, latKey, lonKey, altitudeKey, metadataFields = [], metadataSchemaId = null }) {
  const points = events.filter((event) => validKmlPosition(event[latKey], event[lonKey]) && kmlTime(event));
  if (!points.length) return "";
  const whens = points.map((event) => `        <when>${xmlEscape(kmlTime(event))}</when>`).join("\n");
  const coordinates = points.map((event) => {
    const altitude = Number(event[altitudeKey]);
    return `        <gx:coord>${Number(event[lonKey])} ${Number(event[latKey])} ${Number.isFinite(altitude) ? altitude : 0}</gx:coord>`;
  }).join("\n");
  const extendedData = metadataFields.length && metadataSchemaId
    ? `
        <ExtendedData>
          <SchemaData schemaUrl="#${xmlEscape(metadataSchemaId)}">
${metadataFields.map(([fieldName, , valueFor]) => `            <gx:SimpleArrayData name="${fieldName}">${points.map((event) => `<gx:value>${xmlEscape(valueFor(event))}</gx:value>`).join("")}</gx:SimpleArrayData>`).join("\n")}
          </SchemaData>
        </ExtendedData>`
    : "";
  return `    <Placemark>
      <name>${xmlEscape(name)}</name>
      <description>${xmlEscape(description)}</description>
      <styleUrl>${styleUrl}</styleUrl>
      <gx:Track>
        <altitudeMode>absolute</altitudeMode>
${whens}
${coordinates}
${extendedData}
      </gx:Track>
    </Placemark>`;
}

function buildKlvKml(streamId, events) {
  const trackMetadataSchema = KML_TRACK_METADATA_FIELDS.map(([fieldName, displayName]) => (
    `      <gx:SimpleArrayField name="${fieldName}" type="string"><displayName>${xmlEscape(displayName)}</displayName></gx:SimpleArrayField>`
  )).join("\n");
  const platformTrack = kmlTrack({
    name: "Platform location",
    description: "Platform/sensor position from KLV sensor latitude, longitude, and altitude.",
    styleUrl: "#platformTrackStyle",
    events,
    latKey: "sensorLat",
    lonKey: "sensorLon",
    altitudeKey: "sensorAltMslM",
    metadataFields: KML_TRACK_METADATA_FIELDS,
    metadataSchemaId: "klvTrackMetadataSchema"
  });
  const spiTrack = kmlTrack({
    name: "Sensor - Frame Center",
    description: "Sensor pointing location from KLV frame-center latitude, longitude, and elevation.",
    styleUrl: "#spiTrackStyle",
    events,
    latKey: "frameCenterLat",
    lonKey: "frameCenterLon",
    altitudeKey: "frameCenterElevationMslM",
    metadataFields: KML_TRACK_METADATA_FIELDS,
    metadataSchemaId: "klvTrackMetadataSchema"
  });
  const targetTrack = kmlTrack({
    name: "Target location",
    description: "Target location from KLV target latitude, longitude, and elevation.",
    styleUrl: "#targetTrackStyle",
    events,
    latKey: "targetLat",
    lonKey: "targetLon",
    altitudeKey: "targetElevationMslM"
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <name>${xmlEscape(`${streamId} KLV telemetry`)}</name>
    <description>Timestamped platform, SPI/frame-center, and target location telemetry exported from the stream&apos;s SQLite KLV dataset.</description>
    <Schema id="klvTrackMetadataSchema" name="KLV track metadata">
${trackMetadataSchema}
    </Schema>
    <Style id="platformTrackStyle"><IconStyle><scale>1.1</scale><Icon><href>https://maps.google.com/mapfiles/kml/shapes/airports.png</href></Icon></IconStyle><LineStyle><color>ffff0000</color><width>3</width></LineStyle></Style>
    <Style id="spiTrackStyle"><IconStyle><scale>1.05</scale><Icon><href>https://maps.google.com/mapfiles/kml/shapes/target.png</href></Icon></IconStyle><LineStyle><color>ff00a5ff</color><width>3</width></LineStyle></Style>
    <Style id="targetTrackStyle"><IconStyle><scale>1.1</scale><Icon><href>https://maps.google.com/mapfiles/kml/shapes/target.png</href></Icon></IconStyle><LineStyle><color>ff00ff00</color><width>3</width></LineStyle></Style>
    <Folder>
      <name>Platform location</name>
${platformTrack || "      <description>No platform positions were present in the stored KLV telemetry.</description>"}
    </Folder>
    <Folder>
      <name>Sensor - Frame Center</name>
${spiTrack || "      <description>No SPI/frame-center positions were present in the stored KLV telemetry.</description>"}
    </Folder>
    <Folder>
      <name>Target location</name>
${targetTrack || "      <description>No target positions were present in the stored KLV telemetry.</description>"}
    </Folder>
  </Document>
</kml>`;
}

app.get("/streams/:streamId/klv/export.csv", async (req, res) => {
  try {
    const streamId = validateTargetLogStreamId(req.params.streamId);
    const [events, timeline, missionData] = await Promise.all([
      store.listForExport(streamId),
      store.getMissionTimeline(streamId),
      store.getMissionDataSummary(streamId)
    ]);
    if (missionData.klvEventCount <= 0) {
      return res.status(409).json({ ok: false, error: "No KLV telemetry available for this source" });
    }
    log.info("klv_export_sqlite_mission_data", {
      streamId,
      exportFormat: "csv",
      kmlTelemetryEventCount: missionData.klvEventCount,
      firstMissionTimeMs: missionData.firstMissionTimeMs,
      lastMissionTimeMs: missionData.lastMissionTimeMs,
      targetLogEntryCount: missionData.targetLogEntryCount,
      activeTargetLogFieldCount: missionData.activeTargetLogFieldCount,
      exportedEventCount: events.length
    });
    const safeStreamId = streamId.replace(/[^a-z0-9_-]+/gi, "_");
    const csv = `\uFEFF${KLV_CSV_COLUMNS.join(",")}\r\n${events.map((event) => klvCsvRow(streamId, event, timeline)).join("\r\n")}${events.length ? "\r\n" : ""}`;
    res.status(200)
      .type("text/csv; charset=utf-8")
      .attachment(`${safeStreamId}-klv-telemetry.csv`)
      .send(csv);
  } catch (error) {
    log.warn("klv_csv_export_error", { streamId: req.params.streamId, error: serializeError(error) });
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/streams/:streamId/klv/export.kml", async (req, res) => {
  try {
    const streamId = validateTargetLogStreamId(req.params.streamId);
    const [events, missionData] = await Promise.all([
      store.listForKmlExport(streamId),
      store.getMissionDataSummary(streamId)
    ]);
    if (missionData.klvEventCount <= 0) {
      return res.status(409).json({ ok: false, error: "No KLV telemetry available for this source" });
    }
    const safeStreamId = streamId.replace(/[^a-z0-9_-]+/gi, "_");
    log.info("klv_export_sqlite_mission_data", {
      streamId,
      exportFormat: "kml",
      kmlTelemetryEventCount: missionData.klvEventCount,
      firstMissionTimeMs: missionData.firstMissionTimeMs,
      lastMissionTimeMs: missionData.lastMissionTimeMs,
      targetLogEntryCount: missionData.targetLogEntryCount,
      activeTargetLogFieldCount: missionData.activeTargetLogFieldCount,
      positionCandidateEventCount: events.length
    });
    res.status(200)
      .type("application/vnd.google-earth.kml+xml; charset=utf-8")
      .attachment(`${safeStreamId}-klv-telemetry.kml`)
      .send(buildKlvKml(streamId, events));
  } catch (error) {
    log.warn("klv_kml_export_error", { streamId: req.params.streamId, error: serializeError(error) });
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

/**
 * Returns one lightweight GeoJSON platform path built from completed
 * HLS-segment samples. `properties.timesMs[index]` belongs to
 * `geometry.coordinates[index]`, allowing the browser to trim a file route
 * to its active WebVTT mission time without requesting full KLV JSON.
 */
app.get("/streams/:streamId/klv/platform-history.geojson", async (req, res) => {
  try {
    const streamId = validateTargetLogStreamId(req.params.streamId);
    const parseOptionalTime = (value, name) => {
      if (value == null || String(value).trim() === "") return null;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error(`${name} must be milliseconds since epoch`);
      return Math.round(parsed);
    };
    const fromMs = parseOptionalTime(req.query.fromMs, "fromMs");
    const toMs = parseOptionalTime(req.query.toMs, "toMs");
    if (fromMs != null && toMs != null && fromMs > toMs) {
      throw new Error("fromMs must be less than or equal to toMs");
    }
    const rawMaxPoints = req.query.maxPoints == null ? PLATFORM_HISTORY_MAX_POINTS : Number(req.query.maxPoints);
    if (!Number.isFinite(rawMaxPoints) || rawMaxPoints < 2) {
      throw new Error("maxPoints must be at least 2");
    }
    const maxPoints = Math.min(PLATFORM_HISTORY_MAX_POINTS, Math.floor(rawMaxPoints));
    const history = await store.listPlatformTrackPoints(streamId, { fromMs, toMs, maxPoints });
    const points = history.points;
    const geometry = points.length >= 2
      ? { type: "LineString", coordinates: points.map((point) => [point.lon, point.lat]) }
      : null;
    res.set("Cache-Control", "no-store");
    res.type("application/geo+json").json({
      type: "Feature",
      properties: {
        streamId,
        sampleSource: "last-platform-position-per-completed-hls-segment",
        fromMs,
        toMs,
        pointCount: points.length,
        sourcePointCount: history.sourcePointCount,
        deduplicatedPointCount: history.deduplicatedPointCount,
        reduced: history.reduced,
        timesMs: points.map((point) => point.tMs)
      },
      geometry
    });
  } catch (error) {
    log.warn("platform_history_geojson_error", { streamId: req.params.streamId, error: serializeError(error) });
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

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

// ---------- API: stream-scoped mission target log ----------
function validateTargetLogStreamId(streamId) {
  resolveStreamRecordingDir(streamId);
  return streamId;
}

function hasTargetLogValue(value) {
  return value !== undefined && value !== null && value !== "";
}

/** Validates active schema fields while retaining historic values from inactive fields. */
async function normalizeTargetLogCustomFields(streamId, suppliedFields, existingFields = {}) {
  if (suppliedFields != null && (typeof suppliedFields !== "object" || Array.isArray(suppliedFields))) {
    throw new Error("customFields must be an object");
  }
  const { fields } = await store.getTargetLog(streamId);
  const result = { ...(existingFields || {}) };
  const supplied = suppliedFields || {};
  for (const field of fields.filter((item) => item.active)) {
    if (Object.prototype.hasOwnProperty.call(supplied, field.key)) {
      const raw = supplied[field.key];
      if (!hasTargetLogValue(raw)) {
        delete result[field.key];
      } else if (field.dataType === "number") {
        const numeric = Number(raw);
        if (!Number.isFinite(numeric)) throw new Error(`${field.label} must be a number`);
        result[field.key] = numeric;
      } else if (field.dataType === "boolean") {
        if (raw !== true && raw !== false) throw new Error(`${field.label} must be true or false`);
        result[field.key] = raw;
      } else {
        result[field.key] = String(raw);
      }
    }
    if (field.required && !hasTargetLogValue(result[field.key])) {
      throw new Error(`${field.label} is required`);
    }
  }
  return result;
}

/** Resolves a KLV mission timestamp to a video offset only when it is within known telemetry coverage. */
async function videoTimeForMissionTime(streamId, missionTimeMs) {
  const timeline = await store.getMissionTimeline(streamId);
  if (!timeline || missionTimeMs < timeline.missionMinMs || missionTimeMs > timeline.missionMaxMs) return null;
  const videoTimeMs = Math.round(timeline.videoBaseMs + (missionTimeMs - timeline.missionBaseMs));
  return Number.isFinite(videoTimeMs) && videoTimeMs >= 0 ? videoTimeMs : null;
}

app.get("/streams/:streamId/target-log", async (req, res) => {
  try {
    const streamId = validateTargetLogStreamId(req.params.streamId);
    res.json({ ok: true, streamId, ...(await store.getTargetLog(streamId)) });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/streams/:streamId/target-log/entries", async (req, res) => {
  try {
    const streamId = validateTargetLogStreamId(req.params.streamId);
    const missionTimeMs = Math.round(Number(req.body?.missionTimeMs));
    if (!Number.isFinite(missionTimeMs) || missionTimeMs < 0) {
      throw new Error("missionTimeMs must be a non-negative number");
    }
    const videoTimeMs = await videoTimeForMissionTime(streamId, missionTimeMs);
    const customFields = await normalizeTargetLogCustomFields(streamId, req.body?.customFields);
    const entry = await store.createTargetLogEntry({
      id: randomUUID(),
      streamId,
      missionId: req.body?.missionId == null ? null : String(req.body.missionId),
      videoProductId: req.body?.videoProductId == null ? null : String(req.body.videoProductId),
      missionTimeMs,
      videoTimeMs,
      observation: req.body?.observation == null ? "" : String(req.body.observation),
      position: req.body?.position,
      positionSource: req.body?.positionSource,
      customFields,
      createdBy: req.body?.createdBy == null ? null : String(req.body.createdBy)
    });
    log.info("target_log_entry_created", { streamId, entryId: entry.id, missionTimeMs: entry.missionTimeMs, videoTimeMs: entry.videoTimeMs });
    res.status(201).json({ ok: true, entry });
  } catch (error) {
    log.warn("target_log_entry_create_error", { streamId: req.params.streamId, error: serializeError(error) });
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.patch("/streams/:streamId/target-log/entries/:entryId", async (req, res) => {
  try {
    const streamId = validateTargetLogStreamId(req.params.streamId);
    const existing = await store.getTargetLogEntry(streamId, req.params.entryId);
    if (!existing) return res.status(404).json({ ok: false, error: "target-log entry not found" });
    const customFields = await normalizeTargetLogCustomFields(streamId, req.body?.customFields, existing.customFields);
    const missionTimeMs = req.body?.missionTimeMs == null ? undefined : Math.round(Number(req.body.missionTimeMs));
    if (missionTimeMs !== undefined && (!Number.isFinite(missionTimeMs) || missionTimeMs < 0)) {
      throw new Error("missionTimeMs must be a non-negative number");
    }
    const entry = await store.updateTargetLogEntry(streamId, req.params.entryId, {
      observation: req.body?.observation,
      customFields,
      position: req.body?.position,
      positionSource: req.body?.positionSource,
      missionTimeMs,
      videoTimeMs: missionTimeMs === undefined ? undefined : await videoTimeForMissionTime(streamId, missionTimeMs)
    });
    res.json({ ok: true, entry });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.delete("/streams/:streamId/target-log/entries/:entryId", async (req, res) => {
  try {
    const streamId = validateTargetLogStreamId(req.params.streamId);
    const deleted = await store.deleteTargetLogEntry(streamId, req.params.entryId);
    if (!deleted) return res.status(404).json({ ok: false, error: "target-log entry not found" });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/streams/:streamId/target-log/fields", async (req, res) => {
  try {
    const streamId = validateTargetLogStreamId(req.params.streamId);
    const field = await store.createTargetLogField({
      id: randomUUID(),
      streamId,
      key: req.body?.key,
      label: req.body?.label,
      dataType: req.body?.dataType,
      required: !!req.body?.required
    });
    res.status(201).json({ ok: true, field });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.delete("/streams/:streamId/target-log/fields/:fieldId", async (req, res) => {
  try {
    const streamId = validateTargetLogStreamId(req.params.streamId);
    const deactivated = await store.deactivateTargetLogField(streamId, req.params.fieldId);
    if (!deactivated) return res.status(404).json({ ok: false, error: "target-log field not found" });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
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
  const mediaProcesses = [
    { role: "Server", pid: process.pid },
    ...[...sources.values()].flatMap((source) => [
      isProcessRunning(source.hls?.proc)
        ? { role: "FFmpeg HLS", streamId: source.streamId, pid: source.hls.proc.pid }
        : null,
      isProcessRunning(source.klvWorker?.proc)
        ? { role: "KLV worker", streamId: source.streamId, pid: source.klvWorker.proc.pid }
        : null
    ]).filter(Boolean),
    Number.isInteger(Number(sfuHealth?.pid)) ? { role: "SFU worker", pid: Number(sfuHealth.pid) } : null,
    Number.isInteger(Number(sfuHealth?.webrtc?.workerPid)) ? { role: "mediasoup worker", pid: Number(sfuHealth.webrtc.workerPid) } : null
  ].filter(Boolean);
  const processCpuPercents = await getProcessCpuPercents(mediaProcesses.map((entry) => entry.pid));

  res.json({
    ...runtime,
    processes: mediaProcesses.map((entry) => ({
      ...entry,
      cpuPercent: processCpuPercents.get(entry.pid) ?? null
    })),
    server: {
      httpPort,
      wsPath: WS_PATH,
      activeSources: sources.size,
      statesTracked: sourceStates.size
    },
    workers: {
      sfu: sfuError ? { ok: false, error: sfuError } : { ok: true, ...sfuHealth },
      klv: klvWorkers
    },
    mediaTools
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

  const ok = sfuOk && mediaTools.ok;
  res.status(ok ? 200 : 503).json({
    ok,
    timestampIso: new Date().toISOString(),
    activeSources: sources.size,
    degradedOrErrorSources: degradedOrError,
    eventLoopLagP99Ms: runtime.process.eventLoopLagMs.p99,
    mediaTools,
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

// This is intentionally a local, token-authenticated control endpoint used by
// `npm run stop`.  It is not part of the public API and cannot be used when the
// server was started directly without a control token.
app.post("/_internal/shutdown", (req, res) => {
  const remoteAddress = req.socket.remoteAddress || "";
  const isLocal = remoteAddress === "127.0.0.1"
    || remoteAddress === "::1"
    || remoteAddress === "::ffff:127.0.0.1";
  const token = req.get("x-shutdown-token") || "";

  if (!SHUTDOWN_CONTROL_TOKEN || !isLocal || token !== SHUTDOWN_CONTROL_TOKEN) {
    res.status(403).json({ ok: false, error: "shutdown control is not authorized" });
    return;
  }
  if (shuttingDown) {
    res.status(409).json({ ok: false, error: "shutdown already in progress" });
    return;
  }

  res.status(202).json({ ok: true, message: "graceful shutdown started" });
  setImmediate(() => {
    shutdown("control_request").catch(() => process.exit(1));
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
