import path from "node:path";
import { fork } from "node:child_process";

const INIT_TIMEOUT_MS = 10000;
const RPC_TIMEOUT_MS = 12000;

function isProcessRunning(proc) {
  return !!proc && proc.exitCode == null && !proc.killed;
}

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

export async function startSfuWorkerClient({ config, onEvent }) {
  const workerPath = path.resolve("./src/sfu/sfu_worker.js");
  const execArgv = sanitizeExecArgv(process.execArgv);
  const workerStdio = (process.env.SFU_WORKER_STDIO || "inherit").toLowerCase() === "quiet"
    ? ["ignore", "ignore", "ignore", "ipc"]
    : ["ignore", "inherit", "inherit", "ipc"];
  const proc = fork(workerPath, [], {
    stdio: workerStdio,
    execArgv
  });

  const pending = new Map();
  let nextId = 1;
  let initialized = false;

  function rejectAllPending(reason) {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(reason);
    }
    pending.clear();
  }

  proc.on("message", (message) => {
    if (!message || typeof message !== "object") return;

    if (message.type === "event") {
      onEvent?.(message);
      return;
    }

    if (message.type === "rpc_result") {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) {
        entry.resolve(message.result);
      } else {
        entry.reject(new Error(message.error?.message || "SFU worker RPC failed"));
      }
    }
  });

  proc.on("exit", (code, signal) => {
    rejectAllPending(new Error(`SFU worker exited (code=${String(code)}, signal=${String(signal)})`));
  });

  const initResult = await new Promise((resolve, reject) => {
    let done = false;
    let initSent = false;

    const sendInit = () => {
      if (done || initSent) return;
      try {
        proc.send({ type: "init", config });
        initSent = true;
      } catch {}
    };

    const onMessage = (message) => {
      if (!message || typeof message !== "object") return;
      if (message.type === "worker_ready") {
        sendInit();
        return;
      }
      if (message.type !== "init_result") return;
      if (done) return;
      done = true;
      cleanup();
      if (message.ok) resolve(message);
      else reject(new Error(message.error?.message || "SFU worker init failed"));
    };

    const onExit = (code, signal) => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error(`SFU worker exited during init (code=${String(code)}, signal=${String(signal)})`));
    };

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error("SFU worker init timeout"));
    }, INIT_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timer);
      proc.off("message", onMessage);
      proc.off("exit", onExit);
    };

    proc.on("message", onMessage);
    proc.on("exit", onExit);
    setTimeout(sendInit, 100);
    setTimeout(sendInit, 500);
  });

  if (!initResult?.ok) throw new Error("SFU worker failed to initialize");
  initialized = true;

  function call(method, params = {}, timeoutMs = RPC_TIMEOUT_MS) {
    if (!initialized) return Promise.reject(new Error("SFU client not initialized"));
    if (!isProcessRunning(proc)) return Promise.reject(new Error("SFU worker is not running"));

    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`SFU RPC timeout for method ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      proc.send({ type: "rpc", id, method, params });
    });
  }

  async function close() {
    initialized = false;
    rejectAllPending(new Error("SFU client closed"));
    if (!isProcessRunning(proc)) return;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        proc.off("exit", onExit);
        resolve();
      };
      const onExit = () => finish();
      proc.once("exit", onExit);
      try { proc.kill("SIGTERM"); } catch {}
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
        finish();
      }, 2000);
    });
  }

  return {
    proc,
    close,
    routerRtpCapabilities: () => call("routerRtpCapabilities"),
    createWebRtcTransport: () => call("createWebRtcTransport"),
    connectWebRtcTransport: (transportId, dtlsParameters) =>
      call("connectWebRtcTransport", { transportId, dtlsParameters }),
    consume: (streamId, transportId, rtpCapabilities) =>
      call("consume", { streamId, transportId, rtpCapabilities }),
    startIngest: ({ streamId, inputUrl, mode, requestId }) =>
      call("startIngest", { streamId, inputUrl, mode, requestId }, 30000),
    stopIngest: (streamId) => call("stopIngest", { streamId }, 10000),
    health: () => call("health"),
    debugSnapshot: () => call("debugSnapshot")
  };
}
