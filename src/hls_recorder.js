/** Builds and controls the FFmpeg process that records a source as HLS. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createServiceLogger, serializeError } from "./service_logger.js";
import { buildVideoArgs } from "./ffmpeg_video.js";
import { HLS_RENDITIONS, NATIVE_ABR_RENDITION_INDEX, resolveHlsRenditions } from "./hls_ladder.js";

const log = createServiceLogger("hls_recorder");
const TRANSIENT_INPUT_WARNING_RE = /Invalid frame dimensions 0x0\./i;
const STOP_TERM_WAIT_MS = Number(process.env.FFMPEG_STOP_TERM_WAIT_MS || 1500);
const STOP_KILL_WAIT_MS = Number(process.env.FFMPEG_STOP_KILL_WAIT_MS || 1500);
const GPU_LADDER_CODECS = new Set(["h264", "hevc"]);
const NVENC_ENCODERS = new Set(["h264_nvenc", "hevc_nvenc"]);

/** Reads an opt-out flag while defaulting the supported CUDA ladder path on. */
function envFlag(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  return !["0", "false", "no", "off"].includes(String(raw).trim().toLowerCase());
}

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

/** Parses ffprobe's DAR/SAR text into a safe positive ratio. */
function parseAspectRatio(value) {
  const match = String(value || "").match(/^\s*(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)\s*$/);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isFinite(numerator) || numerator <= 0 || !Number.isFinite(denominator) || denominator <= 0) return null;
  return { numerator, denominator, value: numerator / denominator };
}

/**
 * Converts ffprobe's SAR text to an FFmpeg filter expression. The strict
 * parser prevents untrusted probe output from being interpolated into the
 * filter graph; missing or invalid SAR means square pixels.
 */
function normalizeSampleAspectRatio(value) {
  const aspectRatio = parseAspectRatio(value);
  return aspectRatio ? `${aspectRatio.numerator}/${aspectRatio.denominator}` : "1/1";
}

/** Resolves the source DAR used to fit square-pixel lower ABR rungs. */
function resolveDisplayAspectRatio(sourceVideo) {
  const declaredDar = parseAspectRatio(sourceVideo?.displayAspectRatio)?.value;
  if (declaredDar) return declaredDar;
  const width = Number(sourceVideo?.width);
  const height = Number(sourceVideo?.height);
  const sar = parseAspectRatio(sourceVideo?.sampleAspectRatio)?.value || 1;
  const derivedDar = (width / height) * sar;
  return Number.isFinite(derivedDar) && derivedDar > 0 ? derivedDar : 16 / 9;
}

function evenDimension(value, maximum) {
  const even = Math.floor(Number(value) / 2) * 2;
  return Math.max(2, Math.min(maximum, even));
}

/**
 * Fits source display geometry into a square-pixel rendition without an
 * intermediate full-resolution scale. Black padding is added only when the
 * source DAR genuinely differs from the rendition DAR.
 */
function fitSquarePixelRendition(rendition, sourceDisplayAspectRatio) {
  const targetWidth = Number(rendition.width);
  const targetHeight = Number(rendition.height);
  const targetDisplayAspectRatio = targetWidth / targetHeight;
  if (sourceDisplayAspectRatio >= targetDisplayAspectRatio) {
    return {
      width: targetWidth,
      height: evenDimension(targetWidth / sourceDisplayAspectRatio, targetHeight)
    };
  }
  return {
    width: evenDimension(targetHeight * sourceDisplayAspectRatio, targetWidth),
    height: targetHeight
  };
}

/**
 * Creates the encoded ABR filter graph while preserving display aspect ratio.
 *
 * The native rung keeps its source-coded dimensions and source SAR. Fixed
 * lower rungs first convert non-square source pixels to their display geometry
 * (`width = height × DAR`), then scale to 16:9 square-pixel outputs. Do not
 * apply the source SAR to the Low 640×360 rung: its square-pixel frame
 * already encodes the target 16:9 display shape.
 */
function buildLadderFilter(
  renditions,
  copyRenditionIndex = null,
  nativeRenditionSampleAspectRatio = "1/1",
  sourceDisplayAspectRatio = 16 / 9,
  useGpuFilters = false
) {
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
    // The native top rung remains in its source-coded dimensions. When it is
    // encoded rather than source-copied, retain its source SAR so browsers
    // present the same display aspect as the live WebRTC path.
    if (renditionIndex === NATIVE_ABR_RENDITION_INDEX) {
      // No scale or pad is necessary: High retains the source's coded frame.
      // `setsar` writes display metadata only, avoiding a redundant frame pass.
      filters.push(`[input${inputIndex}]setsar=${nativeRenditionSampleAspectRatio}[video${renditionIndex}]`);
      return;
    }
    // The fixed lower rungs are square-pixel frames. Fit their scale directly
    // from source DAR, rather than first expanding a 1440×1080/4:3-SAR source
    // to 1920×1080 and then scaling it again.
    const lowerRungFit = fitSquarePixelRendition(rendition, sourceDisplayAspectRatio);
    const needsPadding = lowerRungFit.width !== rendition.width || lowerRungFit.height !== rendition.height;
    const lowerRungFilters = [
      useGpuFilters
        ? `scale_cuda=${lowerRungFit.width}:${lowerRungFit.height}:format=nv12`
        : `scale=${lowerRungFit.width}:${lowerRungFit.height}`,
      "setsar=1"
    ];
    if (needsPadding) {
      lowerRungFilters.push(
        useGpuFilters
          ? `pad_cuda=${rendition.width}:${rendition.height}:(ow-iw)/2:(oh-ih)/2:color=black`
          : `pad=${rendition.width}:${rendition.height}:(ow-iw)/2:(oh-ih)/2:color=black`
      );
    }
    filters.push(
      `[input${inputIndex}]${lowerRungFilters.join(",")}[video${renditionIndex}]`
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

/** Removes software pixel-format forcing so NVENC can consume CUDA frames directly. */
function gpuFilterVideoArgs(videoArgs) {
  const adjusted = [...videoArgs];
  const pixelFormatIndex = adjusted.findIndex((value) => value === "-pix_fmt");
  if (pixelFormatIndex >= 0 && pixelFormatIndex + 1 < adjusted.length) {
    adjusted.splice(pixelFormatIndex, 2);
  }
  return adjusted;
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
  const nativeTopRenditionIndex = NATIVE_ABR_RENDITION_INDEX;
  // Passthrough has no ABR High rung. Every transcode path uses a ladder whose
  // High rendition is derived from the source dimensions supplied by ffprobe.
  const ladder = isPassthrough
    ? { renditions: [{ id: "source", playlist: "v0/index.m3u8" }], copyNativeTopRung: false }
    : resolveHlsRenditions(sourceVideo);
  const renditions = ladder.renditions;
  const copyNativeTopRung = chosen === "xcode-any" && ladder.copyNativeTopRung;
  const nativeRenditionSampleAspectRatio = normalizeSampleAspectRatio(sourceVideo?.sampleAspectRatio);
  const sourceDisplayAspectRatio = resolveDisplayAspectRatio(sourceVideo);
  const sourceAlignedKeyframes = copyNativeTopRung ? "source" : `expr:gte(t,n_forced*${segmentSeconds})`;
  const encodedAbrRenditionIndexes = renditions
    .map((_, index) => index)
    .filter((index) => !(copyNativeTopRung && index === nativeTopRenditionIndex));
  const isFileSource = sourceType === "file";
  const videoProfile = buildVideoArgs(chosen, {
    gpuPreset: isFileSource ? "p1" : undefined
  });
  const gpuFilterEnabled = chosen === "xcode-any"
    && videoProfile.usingGpu
    && NVENC_ENCODERS.has(String(videoProfile.encoder || "").toLowerCase())
    && envFlag("FFMPEG_ABR_GPU_FILTERS", true)
    && GPU_LADDER_CODECS.has(String(sourceVideo?.codec || "").toLowerCase());
  const gpuFilterInputArgs = gpuFilterEnabled
    ? ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]
    : [];
  const abrVideoArgs = gpuFilterEnabled ? gpuFilterVideoArgs(videoProfile.videoArgs) : videoProfile.videoArgs;
  const inputProtocolArgs = /^udp:\/\//i.test(inputUrl)
    ? ["-fifo_size", "2000000", "-overrun_nonfatal", "1"]
    : [];
  const inputTimestampArgs = isFileSource
    ? []
    : ["-use_wallclock_as_timestamps", "1"];
  // File-backed TS recordings can contain isolated malformed PES/transport
  // packets, especially at a recorder's tail. Keep valid video, audio, and
  // KLV flowing while FFmpeg discards only packets it cannot demux safely.
  const inputRecoveryArgs = isFileSource
    ? ["-fflags", "+genpts+discardcorrupt", "-err_detect", "ignore_err"]
    : ["-fflags", "+genpts"];

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
    ...inputRecoveryArgs,
    "-avoid_negative_ts", "make_zero",

    // Keep CUDA-decoded frames on the GPU through the ABR scale/pad graph
    // and NVENC outputs. Unsupported codecs retain the CPU filter path.
    ...gpuFilterInputArgs,

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
  // Do not construct this for passthrough: its source-only rendition has no
  // dynamic High entry, and this output is never used in that mode.
  const singleTranscodeOutput = isSingleTranscode ? [
    "-map", "0:v:0",
    ...videoProfile.videoArgs,
    "-b:v", renditions[nativeTopRenditionIndex].videoBitrate,
    "-maxrate:v", renditions[nativeTopRenditionIndex].maxRate,
    "-bufsize:v", renditions[nativeTopRenditionIndex].bufferSize,
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
  ] : [];
  const abrOutput = [
    ...renditions.flatMap((_, index) => ["-map", index === nativeTopRenditionIndex && copyNativeTopRung ? "0:v:0" : `[video${index}]`]),
    "-an",
    "-sn",
    ...(copyNativeTopRung
      ? scopeVideoArgsToStreams(abrVideoArgs, encodedAbrRenditionIndexes)
      : abrVideoArgs),
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
        : ["-filter_complex", buildLadderFilter(
          renditions,
          copyNativeTopRung ? nativeTopRenditionIndex : null,
          nativeRenditionSampleAspectRatio,
          sourceDisplayAspectRatio,
          gpuFilterEnabled
        ), ...carrierOutput, ...abrOutput])
  ];
  // Runtime state, UI diagnostics, and the startup log share this immutable
  // plan so operators can tell which ABR rungs are encoded or source-copied.
  const renditionPlan = chosen === "xcode-any"
    ? renditions.map((rendition, index) => ({
      ...rendition,
      sourceCopy: copyNativeTopRung && index === nativeTopRenditionIndex,
      processing: copyNativeTopRung && index === nativeTopRenditionIndex ? "source-copy" : "encoded"
    }))
    : [{
      id: isPassthrough ? "source" : "source-h264",
      playlist: "v0/index.m3u8",
      sourceCopy: isPassthrough,
      processing: isPassthrough ? "source-copy" : "encoded"
    }];

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
    gpuFilterEnabled,
    copyNativeTopRung,
    renditions: renditionPlan,
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
    gpuFilterEnabled,
    isAbr: chosen === "xcode-any",
    copyNativeTopRung,
    renditions: renditionPlan,
    videoPlaylistName: chosen === "xcode-any" ? "v0/index.m3u8" : "playlist.m3u8"
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
