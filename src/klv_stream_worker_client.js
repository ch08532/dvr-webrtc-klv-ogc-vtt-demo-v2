/** Starts and controls the worker that turns recorded KLV into WebVTT segments. */
import path from "node:path";
import { fork } from "node:child_process";
import { createServiceLogger, serializeError } from "./service_logger.js";

const log = createServiceLogger("klv_stream_worker_client");
const START_TIMEOUT_MS = 8000;
const STOP_TIMEOUT_MS = 2000;
const FINALIZE_TIMEOUT_MS = Math.max(30000, Number(process.env.KLV_FINALIZE_TIMEOUT_MS || 30000));

/** Removes inspector flags that cannot safely be inherited by a child worker. */
function sanitizeExecArgv(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-e" || arg === "--eval" || arg === "-p" || arg === "--print" || arg === "--input-type") {
      i++;
      continue;
    }
    if (arg.startsWith("--input-type=")) continue;
    if (arg === "--check") continue;
    out.push(arg);
  }
  return out;
}

/** Starts the KLV-to-WebVTT worker and returns its RPC-style control handle. */
export async function startKlvStreamWorker({
  streamId,
  inputUrl,
  outDir,
  videoPlaylistName,
  segmentSeconds,
  maxCuesPerSecond,
  minCueDurSec,
  maxCueDurSec,
  dbPath,
  requestId,
  onDecoded,
  onError
}) {
  const workerPath = path.resolve("./src/klv/klv_stream_worker.js");
  const execArgv = sanitizeExecArgv(process.execArgv);
  const proc = fork(workerPath, [], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    execArgv
  });

  return await new Promise((resolve, reject) => {
    let started = false;
    let settled = false;
    let startSent = false;

    const sendStart = () => {
      if (settled || startSent) return;
      try {
        proc.send({
          type: "start",
          streamId,
          inputUrl,
          outDir,
          videoPlaylistName,
          segmentSeconds,
          maxCuesPerSecond,
          minCueDurSec,
          maxCueDurSec,
          dbPath,
          requestId
        });
        startSent = true;
      } catch {}
    };

    const timeout = setTimeout(() => {
      if (settled || started) return;
      settled = true;
      try { proc.kill("SIGTERM"); } catch {}
      proc.off("error", onProcError);
      proc.off("exit", onProcExit);
      proc.off("message", onMessage);
      reject(new Error(`KLV worker start timeout for stream ${streamId}`));
    }, START_TIMEOUT_MS);

    const onProcError = (error) => {
      if (started) {
        onError?.(error);
        return;
      }
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        proc.off("error", onProcError);
        proc.off("exit", onProcExit);
        proc.off("message", onMessage);
        reject(error);
      }
    };

    const onProcExit = (code, signal) => {
      if (!started && !settled) {
        settled = true;
        clearTimeout(timeout);
        proc.off("error", onProcError);
        proc.off("exit", onProcExit);
        proc.off("message", onMessage);
        reject(new Error(`KLV worker exited before start (code=${String(code)}, signal=${String(signal)})`));
        return;
      }
      if (started && code !== 0) {
        onError?.(new Error(`KLV worker exited (code=${String(code)}, signal=${String(signal)})`));
      }
    };

    const onMessage = (message) => {
      if (!message || typeof message !== "object") return;
      if (message.type === "worker_ready") {
        sendStart();
        return;
      }

      if (message.type === "started" && !settled) {
        started = true;
        settled = true;
        clearTimeout(timeout);
        resolve({
          streamId,
          proc,
          requestId,
          stop: () => stopKlvStreamWorker({ streamId, proc, requestId })
        });
        return;
      }

      if (message.type === "decoded") {
        try {
          onDecoded?.(message);
        } catch (error) {
          log.warn("on_decoded_handler_error", {
            streamId,
            requestId,
            error: serializeError(error)
          });
        }
        return;
      }

      if (message.type === "error") {
        const error = message.error?.message
          ? new Error(message.error.message)
          : new Error(`KLV worker error for stream ${streamId}`);
        if (!started && !settled) {
          settled = true;
          clearTimeout(timeout);
          proc.off("error", onProcError);
          proc.off("exit", onProcExit);
          proc.off("message", onMessage);
          reject(error);
          return;
        }
        onError?.(error);
      }
    };

    proc.on("error", onProcError);
    proc.on("exit", onProcExit);
    proc.on("message", onMessage);

    setTimeout(sendStart, 100);
    setTimeout(sendStart, 500);
  });
}

/** Requests a worker stop and terminates it if it does not exit promptly. */
export async function stopKlvStreamWorker(handle) {
  if (!handle?.proc) return;
  if (handle.proc.exitCode != null || handle.proc.killed) return;

  log.info("stop_requested", { requestId: handle.requestId, streamId: handle.streamId });

  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      handle.proc.off("exit", onExit);
      resolve();
    };
    const onExit = () => finish();
    handle.proc.once("exit", onExit);

    try {
      handle.proc.send({ type: "stop", streamId: handle.streamId });
    } catch {}

    setTimeout(() => {
      try { handle.proc.kill("SIGTERM"); } catch {}
      setTimeout(() => {
        try { handle.proc.kill("SIGKILL"); } catch {}
        finish();
      }, STOP_TIMEOUT_MS);
    }, STOP_TIMEOUT_MS);
  });
}

/** Flushes a finite-file worker and waits for its subtitle artifacts to finish. */
export async function finalizeKlvStreamWorker(handle, { timeoutMs = FINALIZE_TIMEOUT_MS } = {}) {
  if (!handle?.proc || handle.proc.exitCode != null || handle.proc.killed) {
    throw new Error("KLV worker is not available for finalization");
  }

  const effectiveTimeoutMs = Math.max(30000, Number(timeoutMs) || FINALIZE_TIMEOUT_MS);

  const finalizeId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  log.info("finalize_requested", { requestId: handle.requestId, streamId: handle.streamId });

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      handle.proc.off("message", onMessage);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (message) => {
      if (message?.type !== "finalized" || message.finalizeId !== finalizeId) return;
      finish();
    };
    const timer = setTimeout(
      () => finish(new Error(`KLV worker finalization timed out for stream ${handle.streamId} after ${effectiveTimeoutMs}ms`)),
      effectiveTimeoutMs
    );

    handle.proc.on("message", onMessage);
    try {
      handle.proc.send({ type: "finalize", streamId: handle.streamId, finalizeId });
    } catch (error) {
      finish(error);
    }
  });
}
