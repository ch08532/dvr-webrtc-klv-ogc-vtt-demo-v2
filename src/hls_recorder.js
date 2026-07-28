/** Builds and controls the FFmpeg process that records a source as HLS. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createServiceLogger, serializeError } from "./service_logger.js";
import { buildVideoArgs } from "./ffmpeg_video.js";
import { HLS_RENDITIONS, resolveHlsRenditions } from "./hls_ladder.js";

const log = createServiceLogger("hls_recorder");
const TRANSIENT_INPUT_WARNING_RE = /Invalid frame dimensions 0x0\./i;
const STOP_TERM_WAIT_MS = Number(process.env.FFMPEG_STOP_TERM_WAIT_MS || 1500);
const STOP_KILL_WAIT_MS = Number(process.env.FFMPEG_STOP_KILL_WAIT_MS || 1500);

/** Converts public HLS mode values to the recorder's internal encoder modes. */
function normalizeMode(mode) {
  if (!mode || mode === "auto") return "xcode-any";
  return mode;
}

/** Validates and clamps the requested HLS segment duration. */
function normalizeSegmentSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return n;
}

/** Formats a spawned command for safe diagnostic logging. */
function formatCommand(cmd, args) {
  const parts = [cmd, ...args].map((p) => JSON.stringify(String(p)));
  return parts.join(" ");
}

/** Waits for FFmpeg to finish, escalating to a forced kill after a timeout. */
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

/** Extracts FFmpeg's processed media time from a progress key/value record. */
function progressSeconds(fields) {
  const raw = fields.out_time_us ?? fields.out_time_ms;
  const micros = Number(raw);
  if (Number.isFinite(micros) && micros >= 0) return micros / 1_000_000;

  const match = String(fields.out_time || "").match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  return (Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3]);
}

/** Parses FFmpeg's human-readable processing speed value. */
function parseProgressSpeed(value) {
  const speed = Number(String(value || "").replace(/x$/i, ""));
  return Number.isFinite(speed) && speed > 0 ? speed : null;
}

/** Creates the scaling filter graph for encoded ABR rendition branches. */
function buildLadderFilter(renditions, copyRenditionIndex = null) {
  const encodedRenditionIndexes = renditions
    .map((_, index) => index)
    .filter((index) => index !== copyRenditionIndex);
  const splitLabels = Array.from(
    { length: encodedRenditionIndexes.length },
    (_, index) => `[input${index}]`
  ).join("");
  const filters = [`[0:v:0]split=${encodedRenditionIndexes.length}${splitLabels}`];

  encodedRenditionIndexes.forEach((renditionIndex, inputIndex) => {
    const rendition = renditions[renditionIndex];
    filters.push(
      `[input${inputIndex}]scale=${rendition.width}:${rendition.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${rendition.width}:${rendition.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[video${renditionIndex}]`
    );
  });
  return filters.join(";");
}

/** Applies unscoped FFmpeg video options to selected output stream indexes. */
function scopeVideoArgsToStreams(videoArgs, streamIndexes) {
  const optionBases = {
    "-c:v": "-c:v",
    "-preset": "-preset:v",
    "-tune": "-tune:v",
    "-profile:v": "-profile:v",
    "-level": "-level:v",
    "-pix_fmt": "-pix_fmt:v",
    "-x264-params": "-x264-params:v",
    "-g": "-g:v",
    "-keyint_min": "-keyint_min:v"
  };
  const scoped = [];

  for (const streamIndex of streamIndexes) {
    for (let i = 0; i < videoArgs.length; i += 2) {
      const option = videoArgs[i];
      const value = videoArgs[i + 1];
      const base = optionBases[option];
      if (!base || value == null) {
        throw new Error(`cannot scope FFmpeg video option ${String(option)}`);
      }
      scoped.push(`${base}:${streamIndex}`, value);
    }
  }

  return scoped;
}

/** Starts HLS packaging and returns a handle with process and output metadata. */
export function startHlsRecorder({ streamId, inputUrl, outDir, hlsSegmentSeconds, mode, requestId, sourceType = "stream", sourceVideo = null, onProgress }) {
  const requestedMode = normalizeMode(mode);
  const chosen = requestedMode === "copy-h264" || requestedMode === "xcode-single"
    ? requestedMode
    : "xcode-any";
  const isPassthrough = chosen === "copy-h264";
  const isSingleTranscode = chosen === "xcode-single";
  const segmentSeconds = normalizeSegmentSeconds(hlsSegmentSeconds);
  const nativeTopRenditionIndex = 1;
  const ladder = resolveHlsRenditions(sourceVideo);
  const renditions = ladder.renditions;
  const copyNativeTopRung = chosen === "xcode-any" && ladder.copyNativeTopRung;
  const sourceAlignedKeyframes = copyNativeTopRung ? "source" : `expr:gte(t,n_forced*${segmentSeconds})`;
  const encodedAbrRenditionIndexes = renditions
    .map((_, index) => index)
    .filter((index) => !(copyNativeTopRung && index === nativeTopRenditionIndex));
  const isFileSource = sourceType === "file";
  const videoProfile = buildVideoArgs(chosen, {
    gpuPreset: isFileSource ? "p1" : undefined
  });
  const inputProtocolArgs = /^udp:\/\//i.test(inputUrl)
    ? ["-fifo_size", "2000000", "-overrun_nonfatal", "1"]
    : [];
  const inputTimestampArgs = isFileSource
    ? []
    : ["-use_wallclock_as_timestamps", "1"];

  // Keep the full history in the playlist.
  const listSize = 0;
  const abrPlaylist = path.join(outDir, "v%v", "index.m3u8");
  const abrSegmentFilename = path.join(outDir, "v%v", "segment_%06d.ts");
  const metadataPlaylist = path.join(outDir, "playlist.m3u8");
  const metadataSegmentFilename = path.join(outDir, "playlist%d.ts");
  const singlePlaylist = path.join(outDir, "v0", "index.m3u8");
  const singleSegmentFilename = path.join(outDir, "v0", "segment_%06d.ts");
  for (const rendition of renditions) {
    fs.mkdirSync(path.join(outDir, path.dirname(rendition.playlist)), { recursive: true });
  }

  // --- INPUT / BASE ---
  const base = [
    "-hide_banner",
    "-loglevel", "warning",
    "-nostats",
    "-progress", "pipe:1",

    // Live UDP sources need arrival-time timestamps; file sources retain media PTS.
    ...inputTimestampArgs,
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

  // This private playlist preserves source video, audio, and KLV for server-side
  // KLV extraction and keyframe-aligned clip export.  It is the only source-copy
  // carrier: do not add a second file-wide clip-index pass here.
  const carrierOutput = [
    "-map", "0:v:0",
    "-map", "0:a?",
    "-map", "0:d?",
    "-c:v", "copy",
    "-c:a", "copy",
    "-c:d", "copy",
    "-muxpreload", "0",
    "-muxdelay", "0",
    "-f", "hls",
    "-start_number", "0",
    "-hls_time", String(segmentSeconds),
    "-hls_list_size", String(listSize),
    "-hls_segment_type", "mpegts",
    "-hls_flags", "program_date_time",
    "-hls_segment_filename", metadataSegmentFilename,
    metadataPlaylist
  ];
  // Browser playback is intentionally video-only. H.264 passthrough therefore
  // has no audio compatibility requirement.
  const passthroughVideoOutput = [
    "-map", "0:v:0",
    "-c:v", "copy",
    "-muxpreload", "0",
    "-muxdelay", "0",
    "-f", "hls",
    "-start_number", "0",
    "-hls_time", String(segmentSeconds),
    "-hls_list_size", String(listSize),
    "-hls_segment_type", "mpegts",
    "-hls_flags", "program_date_time",
    "-hls_segment_filename", singleSegmentFilename,
    singlePlaylist
  ];
  const singleTranscodeOutput = [
    "-map", "0:v:0",
    ...videoProfile.videoArgs,
    "-b:v", renditions[1].videoBitrate,
    "-maxrate:v", renditions[1].maxRate,
    "-bufsize:v", renditions[1].bufferSize,
    "-force_key_frames", sourceAlignedKeyframes,
    "-muxpreload", "0",
    "-muxdelay", "0",
    "-f", "hls",
    "-start_number", "0",
    "-hls_time", String(segmentSeconds),
    "-hls_list_size", String(listSize),
    "-hls_segment_type", "mpegts",
    "-hls_flags", "independent_segments+program_date_time",
    "-hls_segment_filename", singleSegmentFilename,
    singlePlaylist
  ];
  const abrOutput = [
    ...renditions.flatMap((_, index) => ["-map", index === nativeTopRenditionIndex && copyNativeTopRung ? "0:v:0" : `[video${index}]`]),
    "-an",
    "-sn",
    ...(copyNativeTopRung
      ? scopeVideoArgsToStreams(videoProfile.videoArgs, encodedAbrRenditionIndexes)
      : videoProfile.videoArgs),
    ...(copyNativeTopRung ? [`-c:v:${nativeTopRenditionIndex}`, "copy"] : []),
    ...renditions.flatMap((rendition, index) => {
      if (copyNativeTopRung && index === nativeTopRenditionIndex) return [];
      return [
        `-b:v:${index}`, rendition.videoBitrate,
        `-maxrate:v:${index}`, rendition.maxRate,
        `-bufsize:v:${index}`, rendition.bufferSize
      ];
    }),
    ...(copyNativeTopRung
      ? encodedAbrRenditionIndexes.flatMap((index) => [`-force_key_frames:v:${index}`, sourceAlignedKeyframes])
      : ["-force_key_frames", sourceAlignedKeyframes]),
    "-muxpreload", "0",
    "-muxdelay", "0",
    "-f", "hls",
    "-start_number", "0",
    "-hls_time", String(segmentSeconds),
    "-hls_list_size", String(listSize),
    "-hls_segment_type", "mpegts",
    "-hls_flags", "independent_segments+program_date_time",
    "-hls_segment_filename", abrSegmentFilename,
    "-var_stream_map", renditions.map((_, index) => `v:${index}`).join(" "),
    abrPlaylist
  ];

  // --- FINAL ARG LIST (what you pass to spawn) ---
  const args = [
    ...base,
    ...(isPassthrough
      ? [...carrierOutput, ...passthroughVideoOutput]
      : isSingleTranscode
        ? [...carrierOutput, ...singleTranscodeOutput]
        : ["-filter_complex", buildLadderFilter(renditions, copyNativeTopRung ? nativeTopRenditionIndex : null), ...carrierOutput, ...abrOutput])
  ];

  log.info("start", {
    requestId,
    streamId,
    inputUrl,
    sourceType,
    requestedMode,
    mode: chosen,
    hlsSegmentSeconds: segmentSeconds,
    outDir,
    listSize,
    streamCopy: isPassthrough,
    encoder: videoProfile.encoder,
    usingGpu: videoProfile.usingGpu,
    renditions: chosen === "xcode-any"
      ? renditions.map(({ id, width, height, videoBitrate }, index) => ({
        id,
        width,
        height,
        videoBitrate,
        sourceCopy: copyNativeTopRung && index === nativeTopRenditionIndex
      }))
      : [{ id: isPassthrough ? "source" : "source-h264", playlist: "v0/index.m3u8" }],
    copyNativeTopRung,
    renditions,
    metadataPlaylist,
    hlsSegmentType: "mpegts",
    hlsSegmentFilename: chosen === "xcode-any" ? abrSegmentFilename : singleSegmentFilename
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
    stdio: ["ignore", "pipe", "pipe"]
  });
  proc._intentionalStop = false;
  let progressBuffer = "";
  let progressFields = {};

  proc.stdout.on("data", (chunk) => {
    progressBuffer += chunk.toString();
    const lines = progressBuffer.split(/\r?\n/);
    progressBuffer = lines.pop() || "";

    for (const line of lines) {
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      const key = line.slice(0, separator);
      const value = line.slice(separator + 1);
      progressFields[key] = value;
      if (key !== "progress") continue;

      try {
        onProgress?.({
          processedSeconds: progressSeconds(progressFields),
          speed: parseProgressSpeed(progressFields.speed),
          complete: value === "end"
        });
      } catch (error) {
        log.warn("progress_handler_error", { requestId, streamId, error: serializeError(error) });
      }
      progressFields = {};
    }
  });

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

  return {
    streamId,
    proc,
    requestId,
    encoder: videoProfile.encoder,
    usingGpu: videoProfile.usingGpu,
    isAbr: chosen === "xcode-any",
    copyNativeTopRung,
    renditions,
    videoPlaylistName: chosen === "xcode-any" ? "v0/index.m3u8" : "playlist.m3u8",
    // File clipping reuses this existing source-copy carrier; it adds no second
    // packaging output or delayed first-export indexing step.
    clipCarrierPlaylistName: "playlist.m3u8"
  };
}

/** Gracefully stops an active HLS FFmpeg process. */
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
