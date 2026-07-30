/**
 * Foreground service runner with a local, authenticated graceful-stop command.
 * It deliberately uses only Node built-ins so npm start works after npm install.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const runtimeDir = path.join(rootDir, ".runtime");
const statePath = path.join(runtimeDir, "service.json");
const serverPath = path.join(rootDir, "server.js");
const stopWaitMs = Math.max(1_000, Number(process.env.SHUTDOWN_WAIT_MS || 15_000));

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : 8090;
}

async function isPortAvailable(port) {
  return await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

async function readState() {
  try {
    const value = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (!Number.isInteger(value.pid) || value.pid <= 0 || typeof value.token !== "string") return null;
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Could not read ${statePath}: ${error.message}`);
  }
}

async function removeStateIfMatches(pid) {
  const current = await readState();
  if (!current || current.pid !== pid) return;
  await fs.rm(statePath, { force: true });
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function waitForExit(pid, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (!isRunning(pid) || Date.now() >= deadline) {
        clearInterval(timer);
        resolve(!isRunning(pid));
      }
    }, 150);
  });
}

async function requestGracefulStop(state) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/_internal/shutdown`, {
      method: "POST",
      headers: { "x-shutdown-token": state.token },
      signal: controller.signal
    });
    return response.status === 202 || response.status === 409;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function forceStopTree(pid) {
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      child.once("error", resolve);
      child.once("close", resolve);
    });
    return;
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
}

async function stop(state, { forceOnTimeout = true } = {}) {
  if (!isRunning(state.pid)) {
    await removeStateIfMatches(state.pid);
    console.log("Service is already stopped (removed stale state). ");
    return true;
  }

  const accepted = await requestGracefulStop(state);
  if (!accepted) {
    // Ctrl+C is delivered to both this manager and its foreground child.  The
    // child may therefore have already closed its listener before this local
    // request is sent.  Treat a prompt exit as a successful in-progress stop.
    if (await waitForExit(state.pid, 3_000)) {
      await removeStateIfMatches(state.pid);
      console.log("Service stopped cleanly.");
      return true;
    }
    // Do not kill a PID that might have been reused by another application.
    console.error("Could not authenticate a graceful shutdown request. The service was left running.");
    return false;
  }

  console.log(`Gracefully stopping service (PID ${state.pid})...`);
  if (await waitForExit(state.pid, stopWaitMs)) {
    await removeStateIfMatches(state.pid);
    console.log("Service stopped cleanly.");
    return true;
  }

  if (!forceOnTimeout) return false;
  console.warn(`Graceful shutdown exceeded ${stopWaitMs}ms; terminating its remaining process tree.`);
  await forceStopTree(state.pid);
  const stopped = await waitForExit(state.pid, 3_000);
  if (stopped) await removeStateIfMatches(state.pid);
  return stopped;
}

async function start() {
  const existing = await readState();
  if (existing && isRunning(existing.pid)) {
    throw new Error(`Service is already running (PID ${existing.pid}). Use npm run stop first.`);
  }
  if (existing) await removeStateIfMatches(existing.pid);

  const port = validPort(process.env.HTTP_PORT || 8090);
  if (!(await isPortAvailable(port))) {
    throw new Error(`Port ${port} is already in use. Stop the existing service before starting another one.`);
  }
  const token = randomUUID();
  const child = spawn(process.execPath, [serverPath], {
    cwd: rootDir,
    env: { ...process.env, HTTP_PORT: String(port), SHUTDOWN_CONTROL_TOKEN: token },
    stdio: "inherit",
    windowsHide: false
  });
  const state = { pid: child.pid, port, token, startedAt: new Date().toISOString() };
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

  let stopping = false;
  const stopFromConsole = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal} received; requesting graceful shutdown...`);
    const stopped = await stop(state);
    if (!stopped) process.exitCode = 1;
  };
  process.on("SIGINT", () => { void stopFromConsole("SIGINT"); });
  process.on("SIGTERM", () => { void stopFromConsole("SIGTERM"); });
  process.on("SIGBREAK", () => { void stopFromConsole("SIGBREAK"); });

  const exitCode = await new Promise((resolve) => {
    child.once("close", (code) => resolve(code ?? 1));
  });
  await removeStateIfMatches(child.pid);
  process.exitCode = exitCode;
}

async function main() {
  const command = process.argv[2];
  if (command === "start") return start();
  const state = await readState();
  if (command === "status") {
    if (!state || !isRunning(state.pid)) {
      if (state) await removeStateIfMatches(state.pid);
      console.log("Service is stopped.");
      return;
    }
    console.log(`Service is running (PID ${state.pid}) at http://localhost:${state.port}`);
    return;
  }
  if (command === "stop") {
    if (!state) {
      console.log("Service is stopped.");
      return;
    }
    if (!(await stop(state))) process.exitCode = 1;
    return;
  }
  throw new Error("Usage: node scripts/service-manager.mjs <start|stop|status>");
}

main().catch((error) => {
  console.error(`Service manager failed: ${error.message}`);
  process.exitCode = 1;
});
