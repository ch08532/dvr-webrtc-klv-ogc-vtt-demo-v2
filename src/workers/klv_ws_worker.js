let ws = null;
let wsUrl = null;
let streamId = null;
let mode = "live";

function post(type, extra = {}) {
  self.postMessage({ type, ...extra });
}

function sendSubscribe() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ type: "subscribe", streamId, mode }));
  } catch (error) {
    post("ws_error", { error: String(error?.message || error) });
  }
}

function detachSocketHandlers() {
  if (!ws) return;
  ws.onopen = null;
  ws.onmessage = null;
  ws.onerror = null;
  ws.onclose = null;
}

function closeSocket() {
  if (!ws) return;
  detachSocketHandlers();
  try { ws.close(); } catch {}
  ws = null;
}

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
      post("st0601", { payload });
    }
  };
  ws.onerror = () => {
    post("ws_error", { error: "socket error" });
  };
  ws.onclose = (event) => {
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
