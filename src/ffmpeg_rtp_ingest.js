import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createServiceLogger, serializeError } from "./service_logger.js";
import { buildVideoArgs } from "./ffmpeg_video.js";

const log = createServiceLogger("ffmpeg_rtp_ingest");
const SDP_POLL_MS = 200;
const SDP_WAIT_MS = Number(process.env.FFMPEG_SDP_WAIT_MS || 0);

function buildArgs({ inputUrl, ip, port, rtcpPort, sdpFile, mode }) {
  const videoProfile = buildVideoArgs(mode);

  const base = [
    "-hide_banner", "-loglevel", "warning",
    "-fflags", "nobuffer", "-flags", "low_delay",
    ...videoProfile.inputArgs,
    "-i", inputUrl,
    "-an"
  ];

  const out = [
    "-f", "rtp",
    "-sdp_file", sdpFile,
    `rtp://${ip}:${port}?rtcpport=${rtcpPort}&pkt_size=1200`
  ];

  return {
    args: [...base, ...videoProfile.videoArgs, ...out],
    videoProfile
  };
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

export async function startFfmpegRtpIngest({ inputUrl, sfu, streamId, mode, requestId }) {
  const { ip, bindIp, port, rtcpPort } = sfu.ingestInfo(streamId);

  const sdpDir = path.resolve("./db");
  const sdpFile = path.join(sdpDir, `${streamId}.sdp`);
  await fs.unlink(sdpFile).catch(() => {});

  const { args, videoProfile } = buildArgs({ inputUrl, ip, port, rtcpPort, sdpFile, mode });
  log.info("start", {
    requestId,
    streamId,
    inputUrl,
    mode,
    ip,
    bindIp,
    port,
    rtcpPort,
    sdpFile,
    encoder: videoProfile.encoder,
    usingGpu: videoProfile.usingGpu,
    hwaccel: videoProfile.hwaccel
  });

  const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  let exited = false;
  let exitCode = null;
  let exitSignal = null;
  const stderrTail = [];
  const maxStderrTail = 20;

  proc.stderr.on("data", (chunk) => {
    const lines = chunk.toString().split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    for (const line of lines) {
      stderrTail.push(line);
      if (stderrTail.length > maxStderrTail) stderrTail.shift();
      log.warn("ffmpeg_stderr", { requestId, streamId, line });
    }
  });

  proc.on("error", (error) => {
    log.error("process_error", { requestId, streamId, error: serializeError(error) });
  });

  proc.on("exit", (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
    const event = code === 0 ? "exit_clean" : "exit_unexpected";
    const level = code === 0 ? "info" : "warn";
    log[level](event, { requestId, streamId, code, signal });
  });

  const maxAttempts = SDP_WAIT_MS > 0
    ? Math.max(1, Math.ceil(SDP_WAIT_MS / SDP_POLL_MS))
    : Number.POSITIVE_INFINITY;

  for (let i = 0; i < maxAttempts; i++) {
    if (exited) {
      throw new Error(
        `FFmpeg exited before RTP ingest was ready (code=${String(exitCode)}, signal=${String(exitSignal)})`
      );
    }

    try {
      const sdpText = await fs.readFile(sdpFile, "utf8");
      const rtpParameters = parseSdpToRtpParameters(sdpText);
      if (exited) {
        throw new Error(
          `FFmpeg exited before RTP ingest producer was created (code=${String(exitCode)}, signal=${String(exitSignal)})`
        );
      }
      const producerId = await sfu.setIngestProducer(streamId, rtpParameters);
      if (exited) {
        throw new Error(
          `FFmpeg exited immediately after producer creation (code=${String(exitCode)}, signal=${String(exitSignal)})`
        );
      }
      log.info("ready", { requestId, streamId, producerId, attempts: i + 1 });
      return { streamId, proc, producerId, requestId };
    } catch (error) {
      if (i === 0 || (i + 1) % Math.max(1, Math.floor(2000 / SDP_POLL_MS)) === 0) {
        log.debug("waiting_for_sdp", { requestId, streamId, attempts: i + 1, error: error?.message });
      }
      await new Promise(r => setTimeout(r, SDP_POLL_MS));
    }
  }
  log.error("sdp_timeout", {
    requestId,
    streamId,
    sdpFile,
    maxAttempts,
    waitMs: SDP_WAIT_MS,
    stderrTail
  });
  throw new Error("Failed to read SDP from ffmpeg (RTP ingest not ready)");
}

export async function stopFfmpegRtpIngest(handle) {
  if (!handle?.proc) return;
  log.info("stop_requested", { requestId: handle.requestId, streamId: handle.streamId });
  try { handle.proc.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { handle.proc.kill("SIGKILL"); } catch {} }, 1200);
}
