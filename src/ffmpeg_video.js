function envFlag(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  const value = String(raw).trim().toLowerCase();
  if (!value) return defaultValue;
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  return defaultValue;
}

function envString(name, defaultValue = "") {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  const value = String(raw).trim();
  return value || defaultValue;
}

function envNumber(name, defaultValue) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : defaultValue;
}

export function buildVideoArgs(mode, { gpuPreset, purpose } = {}) {
  const isWebRtc = purpose === "webrtc";
  const webRtcBitrate = envString("FFMPEG_WEBRTC_VIDEO_BITRATE", "2500k");
  const webRtcMaxRate = envString("FFMPEG_WEBRTC_MAXRATE", webRtcBitrate);
  const webRtcBufferSize = envString("FFMPEG_WEBRTC_BUFSIZE", webRtcBitrate);
  if (mode === "copy-h264") {
    return {
      inputArgs: [],
      videoArgs: ["-c:v", "copy"],
      encoder: "copy",
      usingGpu: false,
      hwaccel: null
    };
  }

  const useGpu = envFlag("FFMPEG_USE_GPU", true);
  if (!useGpu) {
    const videoArgs = [
      "-c:v", "libx264",
      "-preset", envString("FFMPEG_X264_PRESET", "veryfast"),
      "-tune", envString("FFMPEG_X264_TUNE", "zerolatency"),
      "-profile:v", "baseline",
      "-level", envString("FFMPEG_H264_LEVEL", "4.2"),
      "-pix_fmt", "yuv420p",
      "-x264-params", "keyint=30:min-keyint=30:no-scenecut=1"
    ];
    if (isWebRtc) {
      videoArgs.push(
        "-bf", "0",
        "-b:v", webRtcBitrate,
        "-maxrate", webRtcMaxRate,
        "-bufsize", webRtcBufferSize
      );
    }
    return {
      inputArgs: [],
      videoArgs,
      encoder: "libx264",
      usingGpu: false,
      hwaccel: null
    };
  }

  const encoder = envString("FFMPEG_GPU_CODEC", "h264_nvenc");
  const hwaccel = envString("FFMPEG_HWACCEL", "auto");
  const preset = gpuPreset || envString("FFMPEG_GPU_PRESET", encoder === "h264_nvenc" ? "p4" : "");
  const tune = envString("FFMPEG_GPU_TUNE", encoder === "h264_nvenc" ? "ll" : "");
  const gop = String(envNumber("FFMPEG_GOP", 30));

  const inputArgs = [];
  if (hwaccel && hwaccel.toLowerCase() !== "none") {
    inputArgs.push("-hwaccel", hwaccel);
  }

  const videoArgs = ["-c:v", encoder];
  if (preset) videoArgs.push("-preset", preset);
  if (tune) videoArgs.push("-tune", tune);

  videoArgs.push(
    "-profile:v", "baseline",
    "-level", envString("FFMPEG_H264_LEVEL", "4.2"),
    "-pix_fmt", "yuv420p",
    "-g", gop,
    "-keyint_min", gop
  );

  if (isWebRtc) {
    videoArgs.push(
      "-bf", "0",
      "-b:v", webRtcBitrate,
      "-maxrate", webRtcMaxRate,
      "-bufsize", webRtcBufferSize
    );
    if (encoder === "h264_nvenc") {
      videoArgs.push(
        "-forced-idr", "1",
        "-zerolatency", "1",
        "-strict_gop", "1",
        "-rc", "cbr"
      );
    }
  }

  return {
    inputArgs,
    videoArgs,
    encoder,
    usingGpu: true,
    hwaccel: hwaccel && hwaccel.toLowerCase() !== "none" ? hwaccel : null
  };
}
