/** Browser worker that reconnects to the live KLV WebSocket without blocking the UI. */
let ws = null;
let wsUrl = null;
let streamId = null;
let mode = "live";
const UI_UPDATE_INTERVAL_MS = 100;
let pendingTelemetry = null;
let telemetryTimer = null;
let lastTelemetryPostMs = 0;

/** Sends a status or telemetry event back to the browser main thread. */
function post(type, extra = {}) {
  self.postMessage({ type, ...extra });
}

/** Clears queued telemetry when a socket is replaced or disconnected. */
function clearTelemetryQueue() {
  if (telemetryTimer) clearTimeout(telemetryTimer);
  telemetryTimer = null;
  pendingTelemetry = null;
  lastTelemetryPostMs = 0;
}

/** Batches telemetry messages to avoid overwhelming the browser UI thread. */
function queueTelemetry(payload) {
  pendingTelemetry = payload;
  if (telemetryTimer) return;

  const delay = Math.max(0, UI_UPDATE_INTERVAL_MS - (Date.now() - lastTelemetryPostMs));
  telemetryTimer = setTimeout(() => {
    telemetryTimer = null;
    const latest = pendingTelemetry;
    pendingTelemetry = null;
    lastTelemetryPostMs = Date.now();
    if (latest) post("st0601", { payload: latest });
  }, delay);
}

/** Sends the current stream subscription after the WebSocket opens. */
function sendSubscribe() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ type: "subscribe", streamId, mode }));
  } catch (error) {
    post("ws_error", { error: String(error?.message || error) });
  }
}

/** Removes handlers from a socket that is about to be discarded. */
function detachSocketHandlers() {
  if (!ws) return;
  ws.onopen = null;
  ws.onmessage = null;
  ws.onerror = null;
  ws.onclose = null;
}

/** Closes and clears the active WebSocket connection. */
function closeSocket() {
  clearTelemetryQueue();
  if (!ws) return;
  detachSocketHandlers();
  try { ws.close(); } catch {}
  ws = null;
}

/** Opens the requested live KLV WebSocket and installs reconnect handling. */
function connect(url) {
  if (typeof url === "string" && url.trim()) {
    wsUrl = url.trim();
  }
  if (!wsUrl) {
    post("ws_error", { error: "missing ws url" });
    return;
  }

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    post("ws_open");
    sendSubscribe();
  };
  ws.onmessage = (event) => {
    let payload;
    try {
      payload = JSON.parse(String(event.data || ""));
    } catch {
      return;
    }
    if (payload?.type === "st0601") {
      queueTelemetry(payload);
    }
  };
  ws.onerror = () => {
    post("ws_error", { error: "socket error" });
  };
  ws.onclose = (event) => {
    clearTelemetryQueue();
    post("ws_close", {
      code: event?.code ?? null,
      reason: event?.reason || ""
    });
    ws = null;
  };
}

self.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type === "connect") {
    connect(msg.url);
    return;
  }

  if (msg.type === "subscribe") {
    streamId = msg.streamId ?? null;
    mode = msg.mode || "live";
    sendSubscribe();
    return;
  }

  if (msg.type === "disconnect") {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "subscribe", streamId: null, mode: "live" }));
      } catch {}
    }
    closeSocket();
    return;
  }
};
