/** Checks the FFmpeg tools used by this service before the media pipeline starts. */
import { spawnSync } from "node:child_process";

const CHECK_TIMEOUT_MS = Math.max(1_000, Number(process.env.MEDIA_TOOL_CHECK_TIMEOUT_MS || 8_000));

function firstLine(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
}

/** Extracts the version token from FFmpeg's standard "<tool> version <value>" line. */
function versionNumber(versionLine) {
  return String(versionLine || "").match(/^\S+\s+version\s+(\S+)/i)?.[1] || null;
}

function errorMessage(result) {
  if (result.error) return result.error.message || String(result.error);
  const output = firstLine(result.stderr) || firstLine(result.stdout);
  return output || `exited with code ${String(result.status)}`;
}

/** Runs a bounded command without a shell and returns its availability and version output. */
function checkVersion(command) {
  const result = spawnSync(command, ["-version"], {
    encoding: "utf8",
    timeout: CHECK_TIMEOUT_MS,
    windowsHide: true
  });
  const available = !result.error && result.status === 0;
  const version = available ? firstLine(result.stdout) || firstLine(result.stderr) : null;
  return {
    command,
    available,
    version,
    versionNumber: versionNumber(version),
    error: available ? null : errorMessage(result)
  };
}

/** Checks that the configured hardware encoder can create an actual frame, not merely that it was compiled in. */
function checkGpuEncoder(ffmpegCommand, encoder) {
  const result = spawnSync(ffmpegCommand, [
    "-hide_banner", "-loglevel", "error",
    // NVENC rejects very small frame sizes; 320x180 stays lightweight while
    // satisfying the common hardware encoders' minimum dimensions.
    "-f", "lavfi", "-i", "color=c=black:s=320x180:r=1",
    "-frames:v", "1", "-an", "-c:v", encoder,
    "-f", "null", "-"
  ], {
    encoding: "utf8",
    timeout: CHECK_TIMEOUT_MS,
    windowsHide: true
  });
  const available = !result.error && result.status === 0;
  return {
    encoder,
    available,
    error: available ? null : errorMessage(result)
  };
}

/** Returns the media-tool diagnostic payload used in startup logs and health responses. */
export function checkMediaTools({ ffmpegCommand = "ffmpeg", ffprobeCommand = "ffprobe" } = {}) {
  const ffmpeg = checkVersion(ffmpegCommand);
  const ffprobe = checkVersion(ffprobeCommand);
  const configuredGpuEncoder = String(process.env.FFMPEG_GPU_CODEC || "h264_nvenc").trim() || "h264_nvenc";
  const gpu = ffmpeg.available
    ? checkGpuEncoder(ffmpegCommand, configuredGpuEncoder)
    : { encoder: configuredGpuEncoder, available: false, error: "FFmpeg is unavailable; GPU encoder was not tested" };

  return {
    ok: ffmpeg.available && ffprobe.available,
    checkedAtIso: new Date().toISOString(),
    ffmpeg,
    ffprobe,
    gpu
  };
}
