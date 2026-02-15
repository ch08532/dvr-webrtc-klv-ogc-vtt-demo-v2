import { spawn } from "node:child_process";
import path from "node:path";
import { createServiceLogger, serializeError } from "./service_logger.js";
import { buildVideoArgs } from "./ffmpeg_video.js";

const log = createServiceLogger("hls_recorder");

function normalizeMode(mode) {
  if (!mode || mode === "auto") return "xcode-any";
  return mode;
}

function normalizeSegmentSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return n;
}

export function startHlsRecorder({ streamId, inputUrl, outDir, dvrSeconds, hlsSegmentSeconds, mode, requestId }) {
  const chosen = normalizeMode(mode);
  const videoProfile = buildVideoArgs(chosen);
  const segmentSeconds = normalizeSegmentSeconds(hlsSegmentSeconds);

  // list_size ~= dvrSeconds / segmentSeconds => “DVR window”
  const listSize = Math.max(3, Math.ceil(Number(dvrSeconds) / segmentSeconds));
  const playlist = path.join(outDir, "playlist.m3u8");

  const base = [
    "-hide_banner", "-loglevel", "warning",
    "-fflags", "nobuffer", "-flags", "low_delay",
    ...videoProfile.inputArgs,
    "-i", inputUrl,
    "-an"
  ];

  const hls = [
    "-f", "hls",
    "-hls_time", String(segmentSeconds),
    "-hls_list_size", String(listSize),
    "-hls_flags", "delete_segments+append_list+program_date_time",
    "-hls_segment_type", "fmp4",
    "-hls_fmp4_init_filename", "init.mp4",
    playlist
  ];

  const args = [...base, ...videoProfile.videoArgs, ...hls];
  log.info("start", {
    requestId,
    streamId,
    inputUrl,
    mode: chosen,
    dvrSeconds,
    hlsSegmentSeconds: segmentSeconds,
    outDir,
    listSize,
    encoder: videoProfile.encoder,
    usingGpu: videoProfile.usingGpu,
    hwaccel: videoProfile.hwaccel
  });

  const proc = spawn("ffmpeg", args, {
    cwd: outDir,
    stdio: ["ignore", "ignore", "pipe"]
  });

  proc.stderr.on("data", (chunk) => {
    const lines = chunk.toString().split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    for (const line of lines) {
      log.warn("ffmpeg_stderr", { requestId, streamId, line });
    }
  });

  proc.on("error", (error) => {
    log.error("process_error", { requestId, streamId, error: serializeError(error) });
  });

  proc.on("exit", (code, signal) => {
    const event = code === 0 ? "exit_clean" : "exit_unexpected";
    const level = code === 0 ? "info" : "warn";
    log[level](event, { requestId, streamId, code, signal });
  });

  return { streamId, proc, requestId };
}

export async function stopHlsRecorder(hls) {
  if (!hls?.proc) return;
  log.info("stop_requested", { requestId: hls.requestId, streamId: hls.streamId });
  try { hls.proc.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { hls.proc.kill("SIGKILL"); } catch {} }, 1200);
}
