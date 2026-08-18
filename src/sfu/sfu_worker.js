/** Hosts mediasoup outside the HTTP process and dispatches IPC RPC requests. */
import { createWebRtcSfu } from "../webrtc_sfu.js";
import { startFfmpegRtpIngest, stopFfmpegRtpIngest } from "../ffmpeg_rtp_ingest.js";
import { createServiceLogger, serializeError } from "../service_logger.js";

const log = createServiceLogger("sfu_worker");
const WEBRTC_DIAG_INTERVAL_MS = Math.max(0, Number(process.env.WEBRTC_DIAG_INTERVAL_MS || 5000));

let sfu = null;
let initialized = false;
const ingestHandles = new Map(); // streamId -> { handle, stopping }
let diagTimer = null;

/** Safely sends an IPC event or RPC response to the parent process. */
function send(message) {
  try {
    if (process.connected) process.send?.(message);
  } catch {}
}

/** Creates the SFU once from the parent-provided runtime configuration. */
async function init(config) {
  if (initialized) return;
  const {
    announcedIp = "127.0.0.1",
    rtcMinPort = 40000,
    rtcMaxPort = 49999
  } = config || {};

  sfu = await createWebRtcSfu({ announcedIp, rtcMinPort, rtcMaxPort });
  initialized = true;
  log.info("initialized", { announcedIp, rtcMinPort, rtcMaxPort });

  if (WEBRTC_DIAG_INTERVAL_MS > 0) {
    diagTimer = setInterval(() => {
      try {
        const snapshot = sfu.debugSnapshot?.();
        if (!snapshot) return;
        if ((snapshot.ingestCount ?? 0) === 0 && (snapshot.consumerCount ?? 0) === 0) return;
        log.debug("webrtc_diag_snapshot", snapshot);
      } catch (error) {
        log.warn("webrtc_diag_snapshot_error", { error: serializeError(error) });
      }
    }, WEBRTC_DIAG_INTERVAL_MS);
  }
}

/** Fails an RPC request until SFU initialization has completed. */
function assertReady() {
  if (!initialized || !sfu) throw new Error("SFU worker not initialized");
}

/** Tests whether a child process associated with ingest is still running. */
function isProcessRunning(proc) {
  return !!proc && proc.exitCode == null && !proc.killed;
}

/** Records a child ingest handle and attaches its exit/error lifecycle events. */
async function attachIngest(streamId, handle) {
  ingestHandles.set(streamId, { handle, stopping: false });
  handle.proc?.once("exit", async (code, signal) => {
    const entry = ingestHandles.get(streamId);
    if (!entry || entry.handle !== handle) return;
    ingestHandles.delete(streamId);
    try { await sfu.closeIngest(streamId); } catch {}
    send({
      type: "event",
      event: "ingest_exit",
      streamId,
      code,
      signal,
      intentional: !!entry.stopping
    });
  });
}

/** Dispatches a parent RPC method to the owned SFU instance. */
async function rpc(method, params) {
  assertReady();
  switch (method) {
    case "routerRtpCapabilities":
      return sfu.routerRtpCapabilities();
    case "createWebRtcTransport":
      return sfu.createWebRtcTransport();
    case "connectWebRtcTransport":
      return sfu.connectWebRtcTransport(params?.transportId, params?.dtlsParameters);
    case "consume":
      return sfu.consume(params?.streamId, params?.transportId, params?.rtpCapabilities);
    case "startIngest": {
      const streamId = params?.streamId;
      const inputUrl = params?.inputUrl;
      const mode = params?.mode;
      const sdpFile = params?.sdpFile;
      const requestId = params?.requestId;
      if (!streamId || !inputUrl) throw new Error("streamId and inputUrl required");

      const existing = ingestHandles.get(streamId);
      if (existing?.handle) {
        existing.stopping = true;
        await stopFfmpegRtpIngest(existing.handle);
        ingestHandles.delete(streamId);
      }

      await sfu.ensureIngest(streamId);
      const handle = await startFfmpegRtpIngest({
        inputUrl,
        sfu,
        streamId,
        sdpFile,
        mode,
        requestId
      });
      await attachIngest(streamId, handle);
      return {
        producerId: handle.producerId,
        streamId
      };
    }
    case "stopIngest": {
      const streamId = params?.streamId;
      if (!streamId) return { ok: true };
      const entry = ingestHandles.get(streamId);
      if (entry?.handle) {
        entry.stopping = true;
        await stopFfmpegRtpIngest(entry.handle);
        ingestHandles.delete(streamId);
      }
      await sfu.closeIngest(streamId);
      return { ok: true };
    }
    case "health": {
      const webrtc = sfu.debugSnapshot?.() ?? null;
      const streams = [];
      for (const [streamId, entry] of ingestHandles.entries()) {
        streams.push({
          streamId,
          running: isProcessRunning(entry.handle?.proc),
          producerId: entry.handle?.producerId ?? null,
          stopping: !!entry.stopping
        });
      }
      return {
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        initialized,
        ingestCount: ingestHandles.size,
        streams,
        webrtc
      };
    }
    case "debugSnapshot":
      return sfu.debugSnapshot?.() ?? {};
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

/** Stops every ingest child, closes the SFU, and releases worker state. */
async function shutdown() {
  if (diagTimer) {
    clearInterval(diagTimer);
    diagTimer = null;
  }
  for (const [streamId, entry] of ingestHandles.entries()) {
    try {
      entry.stopping = true;
      await stopFfmpegRtpIngest(entry.handle);
    } catch {}
    try { await sfu?.closeIngest(streamId); } catch {}
  }
  ingestHandles.clear();
}

process.on("message", async (message) => {
  if (!message || typeof message !== "object") return;
  try {
    if (message.type === "init") {
      await init(message.config || {});
      send({ type: "init_result", ok: true });
      return;
    }
    if (message.type === "rpc") {
      const result = await rpc(message.method, message.params);
      send({ type: "rpc_result", id: message.id, ok: true, result });
      return;
    }
  } catch (error) {
    if (message.type === "rpc") {
      send({
        type: "rpc_result",
        id: message.id,
        ok: false,
        error: serializeError(error)
      });
      return;
    }
    if (message.type === "init") {
      send({
        type: "init_result",
        ok: false,
        error: serializeError(error)
      });
      process.exit(1);
    }
  }
});

process.on("disconnect", async () => {
  try { await shutdown(); } catch {}
  process.exit(0);
});

process.on("SIGTERM", async () => {
  try { await shutdown(); } catch {}
  process.exit(0);
});

send({ type: "worker_ready" });
