import { Router } from "express";

/**
 * WebRTC signaling facade for the SFU worker.
 *
 * Media never traverses this HTTP process: routes only exchange the
 * mediasoup-compatible negotiation metadata required by browser clients.
 */
export function createWebrtcRouter({ sfuClient, log, serializeError, sleep }) {
  const router = Router();
  router.get("/webrtc/rtpCapabilities", async (_req, res) => {
    try { res.json(await sfuClient.routerRtpCapabilities()); }
    catch (error) { log.error("webrtc_rtp_capabilities_error", { error: serializeError(error) }); res.status(500).json({ ok: false, error: "failed to fetch rtp capabilities" }); }
  });
  router.post("/webrtc/createTransport", async (_req, res) => {
    try { res.json(await sfuClient.createWebRtcTransport()); }
    catch (error) { log.error("webrtc_create_transport_error", { error: serializeError(error) }); res.status(500).json({ ok: false, error: "failed to create transport" }); }
  });
  router.post("/webrtc/connectTransport", async (req, res) => {
    const { transportId, dtlsParameters } = req.body || {};
    try { await sfuClient.connectWebRtcTransport(transportId, dtlsParameters); res.json({ ok: true }); }
    catch (error) { log.error("webrtc_connect_transport_error", { transportId, error: serializeError(error) }); res.status(400).json({ ok: false, error: String(error?.message || error) }); }
  });
  // Retry only the expected startup race where the producer is not ready.
  router.post("/webrtc/consume", async (req, res) => {
    const { streamId, transportId, rtpCapabilities } = req.body || {};
    try {
      let out = null; let lastError = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        try { out = await sfuClient.consume(streamId, transportId, rtpCapabilities); break; }
        catch (error) { lastError = error; if (String(error?.message || error) !== "producer not ready") throw error; if (attempt < 19) await sleep(250); }
      }
      if (!out) {
        log.warn("webrtc_consume_wait_timeout", { streamId, transportId, attempts: 20, lastError: String(lastError?.message || lastError || "") });
        return res.status(503).json({ ok: false, retryable: true, error: "producer not ready" });
      }
      res.json(out);
    } catch (error) { log.error("webrtc_consume_error", { streamId, transportId, error: serializeError(error) }); res.status(400).json({ ok: false, error: String(error?.message || error) }); }
  });
  // Preserve a distinct retryable response while the SFU worker initializes.
  router.get("/webrtc/debug", async (_req, res) => {
    try { res.json({ ok: true, timestampIso: new Date().toISOString(), snapshot: await sfuClient.debugSnapshot() }); }
    catch (error) {
      const message = String(error?.message || error);
      if (message === "SFU client not initialized" || message === "SFU worker is not running") return res.status(503).json({ ok: false, retryable: true, error: message });
      log.error("webrtc_debug_error", { error: serializeError(error) }); res.status(500).json({ ok: false, error: message });
    }
  });
  return router;
}
