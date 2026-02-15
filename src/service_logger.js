import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const LEVEL_WEIGHT = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};
const logContextStorage = new AsyncLocalStorage();

function configuredLevel() {
  const raw = (process.env.SERVICE_LOG_LEVEL || process.env.LOG_LEVEL || "info").toLowerCase();
  return LEVEL_WEIGHT[raw] ? raw : "info";
}

const ACTIVE_LEVEL = configuredLevel();

function shouldLog(level) {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[ACTIVE_LEVEL];
}

function cleanContext(context) {
  if (!context || typeof context !== "object") return "";
  const out = {};
  for (const [k, v] of Object.entries(context)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  const keys = Object.keys(out);
  if (!keys.length) return "";
  return ` ${JSON.stringify(out)}`;
}

export function getLogContext() {
  return logContextStorage.getStore() ?? {};
}

export function runWithLogContext(context, fn) {
  const current = getLogContext();
  return logContextStorage.run({ ...current, ...(context ?? {}) }, fn);
}

export function newRequestId() {
  return randomUUID();
}

export function serializeError(error) {
  if (!error) return null;
  return {
    message: error.message,
    name: error.name,
    stack: error.stack
  };
}

export function createServiceLogger(service) {
  function log(level, event, context) {
    if (!shouldLog(level)) return;
    const ts = new Date().toISOString();
    const mergedContext = { ...getLogContext(), ...(context ?? {}) };
    const line = `${ts} [${level}] [${service}] ${event}${cleanContext(mergedContext)}`;
    if (level === "error") {
      console.error(line);
      return;
    }
    if (level === "warn") {
      console.warn(line);
      return;
    }
    console.log(line);
  }

  return {
    debug(event, context) { log("debug", event, context); },
    info(event, context) { log("info", event, context); },
    warn(event, context) { log("warn", event, context); },
    error(event, context) { log("error", event, context); }
  };
}
