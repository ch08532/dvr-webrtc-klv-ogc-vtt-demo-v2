import * as mediasoup from "mediasoup";
import { createServiceLogger } from "./service_logger.js";

const log = createServiceLogger("webrtc_sfu");

export async function createWebRtcSfu({ announcedIp, rtcMinPort, rtcMaxPort }) {
  const worker = await mediasoup.createWorker({ rtcMinPort, rtcMaxPort });
  log.info("worker_created", { pid: worker.pid, rtcMinPort, rtcMaxPort, announcedIp: announcedIp ?? null });

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
  log.info("router_created", { codecs: router.rtpCapabilities?.codecs?.length ?? 0 });

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
    log.info("ingest_transport_created", {
      streamId,
      ip: plain.tuple.localIp,
      port: plain.tuple.localPort,
      rtcpPort: plain.rtcpTuple.localPort
    });
  }

  function ingestInfo(streamId) {
    const plain = ingestPlainTransports.get(streamId);
    if (!plain) throw new Error("No ingest transport for streamId");
    const bindIp = plain.tuple.localIp;
    const targetIp = (!bindIp || bindIp === "0.0.0.0" || bindIp === "::")
      ? (announcedIp || "127.0.0.1")
      : bindIp;
    return {
      ip: targetIp,
      bindIp,
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
    log.info("producer_set", { streamId, producerId: producer.id });
    return producer.id;
  }

  async function closeIngest(streamId) {
    const p = ingestProducers.get(streamId);
    if (p) { try { p.close(); } catch {} }
    ingestProducers.delete(streamId);

    const t = ingestPlainTransports.get(streamId);
    if (t) { try { t.close(); } catch {} }
    ingestPlainTransports.delete(streamId);
    log.info("ingest_closed", { streamId });
  }

  async function createWebRtcTransport() {
    const transport = await router.createWebRtcTransport({
      listenIps: [{ ip: "0.0.0.0", announcedIp: announcedIp ?? null }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true
    });

    webRtcTransports.set(transport.id, transport);
    log.debug("webrtc_transport_created", { transportId: transport.id });

    transport.on("dtlsstatechange", (state) => {
      log.debug("dtls_state_change", { transportId: transport.id, state });
      if (state === "closed") {
        webRtcTransports.delete(transport.id);
        try { transport.close(); } catch {}
        log.info("webrtc_transport_closed", { transportId: transport.id });
      }
    });

    transport.on("icestatechange", (state) => {
      log.debug("ice_state_change", { transportId: transport.id, state });
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
    log.info("webrtc_transport_connected", { transportId });
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
    log.info("consumer_created", { streamId, transportId, consumerId: consumer.id, producerId: producer.id });

    consumer.on("transportclose", () => {
      log.info("consumer_transport_closed", { consumerId: consumer.id, streamId, transportId });
    });

    consumer.on("producerclose", () => {
      log.info("consumer_producer_closed", { consumerId: consumer.id, streamId, producerId: producer.id });
    });

    return {
      consumerId: consumer.id,
      producerId: producer.id,
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
