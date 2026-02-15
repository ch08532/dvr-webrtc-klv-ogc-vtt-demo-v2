import * as mediasoup from "mediasoup";

export async function createWebRtcSfu({ announcedIp, rtcMinPort, rtcMaxPort }) {
  const worker = await mediasoup.createWorker({ rtcMinPort, rtcMaxPort });

  const router = await worker.createRouter({
    mediaCodecs: [{
      kind: "video",
      mimeType: "video/H264",
      clockRate: 90000,
      parameters: {
        "packetization-mode": 1,
        "profile-level-id": "42e01f",
        "level-asymmetry-allowed": 1
      }
    }]
  });

  const webRtcTransports = new Map();        // id -> transport
  const ingestPlainTransports = new Map();   // streamId -> plain transport
  const ingestProducers = new Map();         // streamId -> producer

  function routerRtpCapabilities() {
    return router.rtpCapabilities;
  }

  async function ensureIngest(streamId) {
    if (ingestPlainTransports.has(streamId)) return;

    const plain = await router.createPlainTransport({
      listenIp: { ip: "0.0.0.0", announcedIp: announcedIp ?? null },
      rtcpMux: false,
      comedia: true
    });

    ingestPlainTransports.set(streamId, plain);
  }

  function ingestInfo(streamId) {
    const plain = ingestPlainTransports.get(streamId);
    if (!plain) throw new Error("No ingest transport for streamId");
    return {
      ip: plain.tuple.localIp,
      port: plain.tuple.localPort,
      rtcpPort: plain.rtcpTuple.localPort
    };
  }

  async function setIngestProducer(streamId, rtpParameters) {
    const plain = ingestPlainTransports.get(streamId);
    if (!plain) throw new Error("No ingest transport for streamId");

    const old = ingestProducers.get(streamId);
    if (old) { try { old.close(); } catch {} }

    const producer = await plain.produce({ kind: "video", rtpParameters });
    ingestProducers.set(streamId, producer);
    return producer.id;
  }

  async function closeIngest(streamId) {
    const p = ingestProducers.get(streamId);
    if (p) { try { p.close(); } catch {} }
    ingestProducers.delete(streamId);

    const t = ingestPlainTransports.get(streamId);
    if (t) { try { t.close(); } catch {} }
    ingestPlainTransports.delete(streamId);
  }

  async function createWebRtcTransport() {
    const transport = await router.createWebRtcTransport({
      listenIps: [{ ip: "0.0.0.0", announcedIp: announcedIp ?? null }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true
    });

    webRtcTransports.set(transport.id, transport);

    transport.on("dtlsstatechange", (state) => {
      if (state === "closed") {
        webRtcTransports.delete(transport.id);
        try { transport.close(); } catch {}
      }
    });

    return {
      transportId: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    };
  }

  async function connectWebRtcTransport(transportId, dtlsParameters) {
    const t = webRtcTransports.get(transportId);
    if (!t) throw new Error("transport not found");
    await t.connect({ dtlsParameters });
  }

  async function consume(streamId, transportId, rtpCapabilities) {
    const t = webRtcTransports.get(transportId);
    if (!t) throw new Error("transport not found");

    const producer = ingestProducers.get(streamId);
    if (!producer) throw new Error("producer not ready");

    if (!router.canConsume({ producerId: producer.id, rtpCapabilities })) {
      throw new Error("cannot consume");
    }

    const consumer = await t.consume({
      producerId: producer.id,
      rtpCapabilities,
      paused: false
    });

    return {
      consumerId: consumer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters
    };
  }

  return {
    routerRtpCapabilities,
    ensureIngest,
    ingestInfo,
    setIngestProducer,
    closeIngest,
    createWebRtcTransport,
    connectWebRtcTransport,
    consume
  };
}
