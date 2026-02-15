import { spawn } from "node:child_process";
import path from "node:path";

function normalizeMode(mode) {
  if (!mode || mode === "auto") return "xcode-any";
  return mode;
}

export function startHlsRecorder({ streamId, inputUrl, outDir, dvrSeconds, mode }) {
  const chosen = normalizeMode(mode);

  // 1-second segments; list_size ~= dvrSeconds => “DVR window”
  const listSize = Math.max(30, Math.floor(dvrSeconds));
  const playlist = path.join(outDir, "playlist.m3u8");

  const base = [
    "-hide_banner", "-loglevel", "warning",
    "-fflags", "nobuffer", "-flags", "low_delay",
    "-i", inputUrl,
    "-an"
  ];

  const video = (chosen === "copy-h264")
    ? ["-c:v", "copy"]
    : [
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-tune", "zerolatency",
      "-profile:v", "baseline",
      "-level", "3.1",
      "-pix_fmt", "yuv420p",
      "-x264-params", "keyint=30:min-keyint=30:no-scenecut=1"
    ];

  const hls = [
    "-f", "hls",
    "-hls_time", "1",
    "-hls_list_size", String(listSize),
    "-hls_flags", "delete_segments+append_list+program_date_time",
    "-hls_segment_type", "fmp4",
    "-hls_fmp4_init_filename", "init.mp4",
    playlist
  ];

  const args = [...base, ...video, ...hls];
  const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });

  proc.stderr.on("data", () => {});
  proc.on("exit", () => {});

  return { streamId, proc };
}

export async function stopHlsRecorder(hls) {
  if (!hls?.proc) return;
  try { hls.proc.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { hls.proc.kill("SIGKILL"); } catch {} }, 1200);
}
