import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createServiceLogger, serializeError } from "./service_logger.js";
import { buildVideoArgs } from "./ffmpeg_video.js";
import { HLS_RENDITIONS } from "./hls_ladder.js";

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

function buildLadderFilter() {
  const metadataInputIndex = HLS_RENDITIONS.length;
  const splitLabels = Array.from(
    { length: HLS_RENDITIONS.length + 1 },
    (_, index) => `[input${index}]`
  ).join("");
  const filters = [`[0:v:0]split=${HLS_RENDITIONS.length + 1}${splitLabels}`];

  HLS_RENDITIONS.forEach((rendition, index) => {
    filters.push(
      `[input${index}]scale=${rendition.width}:${rendition.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${rendition.width}:${rendition.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[video${index}]`
    );
  });
  const metadataRendition = HLS_RENDITIONS[0];
  filters.push(
    `[input${metadataInputIndex}]scale=${metadataRendition.width}:${metadataRendition.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${metadataRendition.width}:${metadataRendition.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[metadata]`
  );

  return filters.join(";");
}

export function startHlsRecorder({ streamId, inputUrl, outDir, hlsSegmentSeconds, mode, requestId }) {
  const requestedMode = normalizeMode(mode);
  const chosen = "xcode-any";
  const videoProfile = buildVideoArgs(chosen);
  const segmentSeconds = normalizeSegmentSeconds(hlsSegmentSeconds);
  const inputProtocolArgs = /^udp:\/\//i.test(inputUrl)
    ? ["-fifo_size", "2000000", "-overrun_nonfatal", "1"]
    : [];

  // Keep the full history in the playlist.
  const listSize = 0;
  const abrPlaylist = path.join(outDir, "v%v", "index.m3u8");
  const abrSegmentFilename = path.join(outDir, "v%v", "segment_%06d.ts");
  const metadataPlaylist = path.join(outDir, "playlist.m3u8");
  const metadataSegmentFilename = path.join(outDir, "playlist%d.ts");
  for (const rendition of HLS_RENDITIONS) {
    fs.mkdirSync(path.join(outDir, path.dirname(rendition.playlist)), { recursive: true });
  }

  // --- INPUT / BASE ---
  const base = [
    "-hide_banner",
    "-loglevel", "warning",

    // You said wallclock was the only way that kept KLV in sync in your source.
    "-use_wallclock_as_timestamps", "1",
    "-fflags", "+genpts",
    "-avoid_negative_ts", "make_zero",

    // Tune probing (TS/KLV)
    "-probesize", "32M",
    "-analyzeduration", "2M",

    ...inputProtocolArgs,

    // Preserve unknown streams (helps with KLV carriage)
    "-copy_unknown",

    "-i", inputUrl,
  ];

  const metadataRendition = HLS_RENDITIONS[0];
  const metadataOutput = [
    "-map", "[metadata]",
    "-map", "0:d?",
    "-an",
    "-sn",
    ...videoProfile.videoArgs,
    "-b:v", metadataRendition.videoBitrate,
    "-maxrate:v", metadataRendition.maxRate,
    "-bufsize:v", metadataRendition.bufferSize,
    "-c:d", "copy",
    "-force_key_frames", `expr:gte(t,n_forced*${segmentSeconds})`,
    "-muxpreload", "0",
    "-muxdelay", "0",
    "-f", "hls",
    "-start_number", "0",
    "-hls_time", String(segmentSeconds),
    "-hls_list_size", String(listSize),
    "-hls_segment_type", "mpegts",
    "-hls_flags", "independent_segments+program_date_time",
    "-hls_segment_filename", metadataSegmentFilename,
    metadataPlaylist
  ];

  const abrOutput = [
    ...HLS_RENDITIONS.flatMap((_, index) => ["-map", `[video${index}]`]),
    "-an",
    "-sn",
    ...videoProfile.videoArgs,
    ...HLS_RENDITIONS.flatMap((rendition, index) => [
      `-b:v:${index}`, rendition.videoBitrate,
      `-maxrate:v:${index}`, rendition.maxRate,
      `-bufsize:v:${index}`, rendition.bufferSize
    ]),
    "-force_key_frames", `expr:gte(t,n_forced*${segmentSeconds})`,
    "-muxpreload", "0",
    "-muxdelay", "0",
    "-f", "hls",
    "-start_number", "0",
    "-hls_time", String(segmentSeconds),
    "-hls_list_size", String(listSize),
    "-hls_segment_type", "mpegts",
    "-hls_flags", "independent_segments+program_date_time",
    "-hls_segment_filename", abrSegmentFilename,
    "-var_stream_map", HLS_RENDITIONS.map((_, index) => `v:${index}`).join(" "),
    abrPlaylist
  ];

  // --- FINAL ARG LIST (what you pass to spawn) ---
  const args = [
    ...base,
    "-filter_complex", buildLadderFilter(),
    ...metadataOutput,
    ...abrOutput
  ];

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
    renditions: HLS_RENDITIONS.map(({ id, width, height, videoBitrate }) => ({ id, width, height, videoBitrate })),
    metadataPlaylist,
    hlsSegmentType: "mpegts",
    hlsSegmentFilename: abrSegmentFilename
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
