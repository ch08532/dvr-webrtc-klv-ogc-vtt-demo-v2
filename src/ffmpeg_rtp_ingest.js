/** Converts an input source into RTP that mediasoup can ingest for live WebRTC. */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createServiceLogger, serializeError } from "./service_logger.js";
import { buildVideoArgs } from "./ffmpeg_video.js";

const log = createServiceLogger("ffmpeg_rtp_ingest");
const SDP_POLL_MS = 200;
const SDP_WAIT_MS = Number(process.env.FFMPEG_SDP_WAIT_MS || 0);
const TRANSIENT_INPUT_WARNING_RE = /Invalid frame dimensions 0x0\./i;
const STOP_TERM_WAIT_MS = Number(process.env.FFMPEG_STOP_TERM_WAIT_MS || 1500);
const STOP_KILL_WAIT_MS = Number(process.env.FFMPEG_STOP_KILL_WAIT_MS || 1500);
const RTP_PAYLOAD_TYPE = Number(process.env.FFMPEG_RTP_PAYLOAD_TYPE || 96);
const RTP_SSRC = Number(process.env.FFMPEG_RTP_SSRC || 22222222);
const UDP_FIFO_SIZE = Math.max(1024, Number(process.env.FFMPEG_WEBRTC_UDP_FIFO_SIZE || 131072));
const UDP_BUFFER_SIZE = Math.max(64 * 1024, Number(process.env.FFMPEG_WEBRTC_UDP_BUFFER_SIZE || 4194304));
const INPUT_THREAD_QUEUE_SIZE = Math.max(256, Number(process.env.FFMPEG_WEBRTC_THREAD_QUEUE_SIZE || 4096));
const INPUT_MAX_DELAY_US = Math.max(0, Number(process.env.FFMPEG_WEBRTC_MAX_DELAY_US || 500000));

/** Quotes a command argument for human-readable logging. */
function formatCommandArg(value) {
  const text = String(value);
  return /[\s"]/u.test(text) ? `"${text.replace(/(["\\])/g, '\\$1')}"` : text;
}

/** Formats a child-process exit code consistently on Windows and preserves FFmpeg's useful stderr. */
function describeFfmpegExit(code, signal, stderrTail) {
  // Windows exposes native signed process status values as unsigned 32-bit
  // numbers.  For example, 4294967256 is FFmpeg's -40 (ELOOP).
  const numericCode = Number(code);
  const signedCode = Number.isInteger(numericCode) && numericCode > 0x7fffffff
    ? numericCode - 0x1_0000_0000
    : code;
  const stderr = stderrTail.filter(Boolean).join("\n");
  const details = [
    `code=${String(code)}`,
    signedCode !== code ? `signedCode=${String(signedCode)}` : "",
    `signal=${String(signal)}`,
    stderr ? `stderr:\n${stderr}` : ""
  ].filter(Boolean).join(", ");
  return details;
}

/** Adds resilient UDP buffering options when the input is a UDP URL. */
function bufferedInputUrl(inputUrl) {
  if (!/^udp:\/\//i.test(String(inputUrl || ''))) return inputUrl;
  try {
    const url = new URL(inputUrl);
    if (!url.searchParams.has('fifo_size')) url.searchParams.set('fifo_size', String(UDP_FIFO_SIZE));
    if (!url.searchParams.has('buffer_size')) url.searchParams.set('buffer_size', String(UDP_BUFFER_SIZE));
    if (!url.searchParams.has('overrun_nonfatal')) url.searchParams.set('overrun_nonfatal', '1');
    return url.toString();
  } catch {
    const separator = String(inputUrl).includes('?') ? '&' : '?';
    return `${inputUrl}${separator}fifo_size=${UDP_FIFO_SIZE}&buffer_size=${UDP_BUFFER_SIZE}&overrun_nonfatal=1`;
  }
}

/** Builds FFmpeg arguments and an SDP description for the RTP output. */
function buildArgs({ inputUrl, ip, port, rtcpPort, sdpFile, mode }) {
  const videoProfile = buildVideoArgs(mode, { purpose: "webrtc" });
  const bufferedInput = bufferedInputUrl(inputUrl);

  const base = [
    "-hide_banner", "-loglevel", "warning",
    "-thread_queue_size", String(INPUT_THREAD_QUEUE_SIZE),
    "-max_delay", String(INPUT_MAX_DELAY_US),
    ...videoProfile.inputArgs,
    "-i", bufferedInput,
    "-an"
  ];

  const out = [
    "-map", "0:v:0",
    "-f", "rtp",
    "-payload_type", String(RTP_PAYLOAD_TYPE),
    "-ssrc", String(RTP_SSRC),
    "-sdp_file", sdpFile,
    `rtp://${ip}:${port}?rtcpport=${rtcpPort}&pkt_size=1200`
  ];

  return {
    args: [...base, ...videoProfile.videoArgs, ...out],
    videoProfile,
    bufferedInput
  };
}

/** Converts FFmpeg-generated SDP fields to mediasoup RTP parameters. */
function parseSdpToRtpParameters(sdpText) {
  const lines = sdpText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  let payloadType = 96;
  let fmtp = "";
  let ssrc = null;

  for (const l of lines) {
    if (l.startsWith("m=video")) {
      const parts = l.split(/\s+/);
      if (parts[3]) payloadType = Number(parts[3]);
    }
    if (l.startsWith(`a=fmtp:${payloadType}`)) {
      fmtp = l.split(" ", 2)[1] || "";
    }
    if (l.startsWith("a=ssrc:")) {
      const match = l.match(/^a=ssrc:(\d+)\s/i);
      if (match && ssrc == null) {
        const parsed = Number(match[1]);
        if (Number.isFinite(parsed) && parsed >= 0) ssrc = parsed;
      }
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
  const encodingSsrc = ssrc ?? RTP_SSRC;

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
    encodings: [{ ssrc: encodingSsrc }]
  };
}

/** Waits for an RTP FFmpeg process and force-stops it after the timeout. */
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

/** Starts FFmpeg RTP output and attaches it to the SFU as a video producer. */
export async function startFfmpegRtpIngest({ inputUrl, sfu, streamId, mode, sdpFile: requestedSdpFile, requestId }) {
  const { ip, bindIp, port, rtcpPort } = sfu.ingestInfo(streamId);

  const sdpFile = requestedSdpFile || path.resolve("./db", `${streamId}.sdp`);
  const sdpDir = path.dirname(sdpFile);
  await fs.mkdir(sdpDir, { recursive: true });
  await fs.unlink(sdpFile).catch(() => {});

  const { args, videoProfile, bufferedInput } = buildArgs({ inputUrl, ip, port, rtcpPort, sdpFile, mode });
  log.info("start", {
    requestId,
    streamId,
    inputUrl,
    bufferedInput,
    mode,
    ip,
    bindIp,
    port,
    rtcpPort,
    sdpFile,
    encoder: videoProfile.encoder,
    usingGpu: videoProfile.usingGpu,
    hwaccel: videoProfile.hwaccel,
    ffmpegCommand: `ffmpeg ${args.map(formatCommandArg).join(" ")}`
  });

  const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  proc._intentionalStop = false;
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
    exited = true;
    exitCode = code;
    exitSignal = signal;
    const intentional = proc._intentionalStop === true;
    if (intentional && (signal === "SIGTERM" || signal === "SIGKILL")) {
      log.info("exit_stopped", { requestId, streamId, code, signal });
      return;
    }
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
        `FFmpeg exited before RTP ingest was ready (${describeFfmpegExit(exitCode, exitSignal, stderrTail)})`
      );
    }

    try {
      const sdpText = await fs.readFile(sdpFile, "utf8");
      const rtpParameters = parseSdpToRtpParameters(sdpText);
      log.debug("rtp_parameters_parsed", {
        requestId,
        streamId,
        payloadType: rtpParameters?.codecs?.[0]?.payloadType ?? null,
        ssrc: rtpParameters?.encodings?.[0]?.ssrc ?? null
      });
      if (!sdpText.includes("a=ssrc:")) {
        log.info("rtp_sdp_missing_ssrc_using_forced", {
          requestId,
          streamId,
          forcedSsrc: RTP_SSRC,
          forcedPayloadType: RTP_PAYLOAD_TYPE
        });
      }
      if (exited) {
        throw new Error(
          `FFmpeg exited before RTP ingest producer was created (${describeFfmpegExit(exitCode, exitSignal, stderrTail)})`
        );
      }
      const producerId = await sfu.setIngestProducer(streamId, rtpParameters);
      if (exited) {
        throw new Error(
          `FFmpeg exited immediately after producer creation (${describeFfmpegExit(exitCode, exitSignal, stderrTail)})`
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

/** Stops the RTP FFmpeg process and removes its temporary SDP file. */
export async function stopFfmpegRtpIngest(handle) {
  if (!handle?.proc) return;
  if (handle.proc.exitCode != null || handle.proc.killed) return;
  handle.proc._intentionalStop = true;
  log.info("stop_requested", { requestId: handle.requestId, streamId: handle.streamId });
  try { handle.proc.kill("SIGTERM"); } catch {}
  const stoppedOnTerm = await waitForExit(handle.proc, STOP_TERM_WAIT_MS);
  if (stoppedOnTerm) return;

  log.warn("stop_escalating", { requestId: handle.requestId, streamId: handle.streamId, signal: "SIGKILL" });
  try { handle.proc.kill("SIGKILL"); } catch {}
  const stoppedOnKill = await waitForExit(handle.proc, STOP_KILL_WAIT_MS);
  if (!stoppedOnKill) {
    log.warn("stop_timeout", { requestId: handle.requestId, streamId: handle.streamId });
  }
}
