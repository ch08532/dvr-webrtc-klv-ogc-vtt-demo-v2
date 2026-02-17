import { spawn } from "node:child_process";
import path from "node:path";
import { createServiceLogger, serializeError } from "./service_logger.js";
import { buildVideoArgs } from "./ffmpeg_video.js";

const log = createServiceLogger("hls_recorder");
const TRANSIENT_INPUT_WARNING_RE = /Invalid frame dimensions 0x0\./i;
const STOP_TERM_WAIT_MS = Number(process.env.FFMPEG_STOP_TERM_WAIT_MS || 1500);
const STOP_KILL_WAIT_MS = Number(process.env.FFMPEG_STOP_KILL_WAIT_MS || 1500);

function normalizeMode(mode) {
  if (!mode || mode === "auto") return "xcode-any";
  return mode;
}

function normalizeSegmentSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return n;
}

function buildHlsFlags() {
  // independent_segments + temp_file avoids clients reading partial/incomplete segments.
  return "append_list+program_date_time+independent_segments+temp_file";
}

function formatCommand(cmd, args) {
  const parts = [cmd, ...args].map((p) => JSON.stringify(String(p)));
  return parts.join(" ");
}

function waitForExit(proc, timeoutMs) {
  if (!proc || proc.exitCode != null || proc.killed) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      proc.off("exit", onExit);
      resolve(ok);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    proc.once("exit", onExit);
  });
}

export function startHlsRecorder({ streamId, inputUrl, outDir, hlsSegmentSeconds, mode, requestId }) {
  const requestedMode = normalizeMode(mode);
  const chosen = "xcode-any";
  const videoProfile = buildVideoArgs(chosen);
  const segmentSeconds = normalizeSegmentSeconds(hlsSegmentSeconds);

  // Keep the full history in the playlist.
  const listSize = 0;
  const playlist = path.join(outDir, "playlist.m3u8");
  const segmentFilename = "playlist%d.ts";

  const base = [
    "-hide_banner", "-loglevel", "warning",
    "-copy_unknown",
    "-fflags", "nobuffer", "-flags", "low_delay",
    ...videoProfile.inputArgs,
    "-i", inputUrl
  ];

  const mediaOut = [
    // Fixed encode path (mode is forced to xcode-any).
    // Include optional input data streams (e.g., KLV) into TS output.
    "-map", "0:v:0",
    "-map", "0:d?",
    "-an",
    "-sn",
    ...videoProfile.videoArgs,
    "-c:d", "copy",
    "-force_key_frames", `expr:gte(t,n_forced*${segmentSeconds})`
  ];

  const hls = [
    "-f", "hls",
    "-hls_time", String(segmentSeconds),
    "-hls_list_size", String(listSize),
    //"-hls_flags", buildHlsFlags(),
    "-hls_segment_type", "mpegts",
    "-hls_segment_filename", segmentFilename,
    playlist
  ];

  const args = [...base, ...mediaOut, ...hls];
  log.info("start", {
    requestId,
    streamId,
    inputUrl,
    requestedMode,
    mode: chosen,
    hlsSegmentSeconds: segmentSeconds,
    outDir,
    listSize,
    streamCopy: false,
    encoder: videoProfile.encoder,
    mapDataStreams: true,
    hlsSegmentType: "mpegts",
    hlsSegmentFilename: segmentFilename,
    hlsFlags: buildHlsFlags()
  });
  log.info("ffmpeg_command", {
    requestId,
    streamId,
    cmd: "ffmpeg",
    args,
    command: formatCommand("ffmpeg", args)
  });

  const proc = spawn("ffmpeg", args, {
    cwd: outDir,
    stdio: ["ignore", "ignore", "pipe"]
  });
  proc._intentionalStop = false;

  proc.stderr.on("data", (chunk) => {
    const lines = chunk.toString().split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    for (const line of lines) {
      if (TRANSIENT_INPUT_WARNING_RE.test(line)) {
        log.debug("ffmpeg_stderr_transient", { requestId, streamId, line });
        continue;
      }
      log.warn("ffmpeg_stderr", { requestId, streamId, line });
    }
  });

  proc.on("error", (error) => {
    log.error("process_error", { requestId, streamId, error: serializeError(error) });
  });

  proc.on("exit", (code, signal) => {
    const intentional = proc._intentionalStop === true;
    if (intentional && (signal === "SIGTERM" || signal === "SIGKILL")) {
      log.info("exit_stopped", { requestId, streamId, code, signal });
      return;
    }
    const event = code === 0 ? "exit_clean" : "exit_unexpected";
    const level = code === 0 ? "info" : "warn";
    log[level](event, { requestId, streamId, code, signal });
  });

  return { streamId, proc, requestId };
}

export async function stopHlsRecorder(hls) {
  if (!hls?.proc) return;
  if (hls.proc.exitCode != null || hls.proc.killed) return;
  hls.proc._intentionalStop = true;
  log.info("stop_requested", { requestId: hls.requestId, streamId: hls.streamId });
  try { hls.proc.kill("SIGTERM"); } catch {}
  const stoppedOnTerm = await waitForExit(hls.proc, STOP_TERM_WAIT_MS);
  if (stoppedOnTerm) return;

  log.warn("stop_escalating", { requestId: hls.requestId, streamId: hls.streamId, signal: "SIGKILL" });
  try { hls.proc.kill("SIGKILL"); } catch {}
  const stoppedOnKill = await waitForExit(hls.proc, STOP_KILL_WAIT_MS);
  if (!stoppedOnKill) {
    log.warn("stop_timeout", { requestId: hls.requestId, streamId: hls.streamId });
  }
}
