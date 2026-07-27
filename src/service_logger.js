/** Provides structured, context-aware logging for server and worker modules. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const LEVEL_WEIGHT = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};
const logContextStorage = new AsyncLocalStorage();

/** Reads the configured minimum log level. */
function configuredLevel() {
  const raw = (process.env.SERVICE_LOG_LEVEL || process.env.LOG_LEVEL || "info").toLowerCase();
  return LEVEL_WEIGHT[raw] ? raw : "info";
}

const ACTIVE_LEVEL = configuredLevel();

/** Checks whether a message at the requested level should be emitted. */
function shouldLog(level) {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[ACTIVE_LEVEL];
}

/** Removes undefined fields so JSON log entries stay compact. */
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

/** Returns the request or worker context attached to the current async call. */
export function getLogContext() {
  return logContextStorage.getStore() ?? {};
}

/** Runs a function with context automatically included in its log entries. */
export function runWithLogContext(context, fn) {
  const current = getLogContext();
  return logContextStorage.run({ ...current, ...(context ?? {}) }, fn);
}

/** Creates a short identifier used to correlate one request across components. */
export function newRequestId() {
  return randomUUID();
}

/** Converts an error into structured fields that are safe to log or return. */
export function serializeError(error) {
  if (!error) return null;
  return {
    message: error.message,
    name: error.name,
    stack: error.stack
  };
}

/** Creates a logger pre-bound to the originating service name. */
export function createServiceLogger(service) {
  /** Emits one structured JSON log event when its level is enabled. */
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
