import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

function buildArgs({ inputUrl, ip, port, rtcpPort, sdpFile, mode }) {
  const base = [
    "-hide_banner", "-loglevel", "warning",
    "-fflags", "nobuffer", "-flags", "low_delay",
    "-i", inputUrl,
    "-an"
  ];

  const video = (mode === "copy-h264")
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

  const out = [
    "-f", "rtp",
    "-sdp_file", sdpFile,
    `rtp://${ip}:${port}?rtcpport=${rtcpPort}&pkt_size=1200`
  ];

  return [...base, ...video, ...out];
}

function parseSdpToRtpParameters(sdpText) {
  const lines = sdpText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  let payloadType = 96;
  let fmtp = "";

  for (const l of lines) {
    if (l.startsWith("m=video")) {
      const parts = l.split(/\s+/);
      if (parts[3]) payloadType = Number(parts[3]);
    }
    if (l.startsWith(`a=fmtp:${payloadType}`)) {
      fmtp = l.split(" ", 2)[1] || "";
    }
  }

  const parameters = {};
  for (const p of fmtp.split(";").map(x => x.trim()).filter(Boolean)) {
    const [k, v] = p.split("=");
    if (!k) continue;
    parameters[k.trim()] = (v ?? "").trim();
  }

  const packetizationMode = parameters["packetization-mode"]
    ? Number(parameters["packetization-mode"])
    : 1;

  return {
    codecs: [{
      mimeType: "video/H264",
      payloadType,
      clockRate: 90000,
      parameters: {
        "packetization-mode": packetizationMode,
        "profile-level-id": parameters["profile-level-id"] || "42e01f",
        "level-asymmetry-allowed": 1
      }
    }],
    encodings: [{ ssrc: 22222222 }]
  };
}

export async function startFfmpegRtpIngest({ inputUrl, sfu, streamId, mode }) {
  const { ip, port, rtcpPort } = sfu.ingestInfo(streamId);

  const sdpDir = path.resolve("./db");
  const sdpFile = path.join(sdpDir, `${streamId}.sdp`);

  const args = buildArgs({ inputUrl, ip, port, rtcpPort, sdpFile, mode });
  const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });

  proc.stderr.on("data", () => {});
  proc.on("exit", () => {});

  for (let i = 0; i < 30; i++) {
    try {
      const sdpText = await fs.readFile(sdpFile, "utf8");
      const rtpParameters = parseSdpToRtpParameters(sdpText);
      const producerId = await sfu.setIngestProducer(streamId, rtpParameters);
      return { streamId, proc, producerId };
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  throw new Error("Failed to read SDP from ffmpeg (RTP ingest not ready)");
}

export async function stopFfmpegRtpIngest(handle) {
  if (!handle?.proc) return;
  try { handle.proc.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { handle.proc.kill("SIGKILL"); } catch {} }, 1200);
}
