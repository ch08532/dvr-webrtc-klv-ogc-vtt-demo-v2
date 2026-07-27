/** Creates the in-process mediasoup SFU used by live browser viewers. */
import * as mediasoup from "mediasoup";
import { createServiceLogger } from "./service_logger.js";

const log = createServiceLogger("webrtc_sfu");
const PLAIN_SOCKET_BUFFER_SIZE = Math.max(64 * 1024, Number(process.env.MEDIASOUP_PLAIN_SOCKET_BUFFER_SIZE || 8 * 1024 * 1024));
const WEBRTC_SOCKET_BUFFER_SIZE = Math.max(64 * 1024, Number(process.env.MEDIASOUP_WEBRTC_SOCKET_BUFFER_SIZE || 4 * 1024 * 1024));

/** Creates an H.264 mediasoup router and returns source-ingest and viewer APIs. */
export async function createWebRtcSfu({ announcedIp, rtcMinPort, rtcMaxPort }) {
  const worker = await mediasoup.createWorker({ rtcMinPort, rtcMaxPort });
  log.info("worker_created", { pid: worker.pid, rtcMinPort, rtcMaxPort, announcedIp: announcedIp ?? null });

  const router = await worker.createRouter({
    mediaCodecs: [{
      kind: "video",
      mimeType: "video/H264",
      clockRate: 90000,
      rtcpFeedback: [
        { type: "nack" },
        { type: "nack", parameter: "pli" },
        { type: "ccm", parameter: "fir" },
        { type: "transport-cc" },
        { type: "goog-remb" }
      ],
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
  const consumers = new Map();               // consumerId -> { consumer, streamId, transportId }

  /** Returns the router capabilities a browser needs before creating a device. */
  function routerRtpCapabilities() {
    return router.rtpCapabilities;
  }

  /** Creates the UDP plain transport used by FFmpeg for one live source. */
  async function ensureIngest(streamId) {
    if (ingestPlainTransports.has(streamId)) return;

    const plain = await router.createPlainTransport({
      listenInfo: {
        protocol: "udp",
        ip: "0.0.0.0",
        announcedAddress: announcedIp || undefined,
        sendBufferSize: PLAIN_SOCKET_BUFFER_SIZE,
        recvBufferSize: PLAIN_SOCKET_BUFFER_SIZE
      },
      rtcpListenInfo: {
        protocol: "udp",
        ip: "0.0.0.0",
        announcedAddress: announcedIp || undefined,
        sendBufferSize: PLAIN_SOCKET_BUFFER_SIZE,
        recvBufferSize: PLAIN_SOCKET_BUFFER_SIZE
      },
      rtcpMux: false,
      comedia: true
    });

    ingestPlainTransports.set(streamId, plain);
    log.info("ingest_transport_created", {
      streamId,
      ip: plain.tuple.localIp,
      port: plain.tuple.localPort,
      rtcpPort: plain.rtcpTuple.localPort,
      socketBufferSize: PLAIN_SOCKET_BUFFER_SIZE
    });

    plain.on("tuple", (tuple) => {
      log.debug("ingest_tuple", { streamId, tuple });
    });
    plain.on("rtcptuple", (rtcpTuple) => {
      log.debug("ingest_rtcp_tuple", { streamId, rtcpTuple });
    });
    plain.on("trace", (trace) => {
      log.debug("ingest_trace", { streamId, trace });
    });
    plain.on("close", () => {
      log.info("ingest_transport_closed", { streamId });
    });
    try {
      await plain.enableTraceEvent(["probation", "bwe"]);
    } catch {}
  }

  /** Returns the plain-transport connection details for FFmpeg RTP output. */
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

  /** Creates or replaces the mediasoup producer for FFmpeg's RTP stream. */
  async function setIngestProducer(streamId, rtpParameters) {
    const plain = ingestPlainTransports.get(streamId);
    if (!plain) throw new Error("No ingest transport for streamId");

    const old = ingestProducers.get(streamId);
    if (old) { try { old.close(); } catch {} }

    const producer = await plain.produce({ kind: "video", rtpParameters });
    ingestProducers.set(streamId, producer);
    log.info("producer_set", { streamId, producerId: producer.id });

    producer.on("score", (score) => {
      log.debug("producer_score", { streamId, producerId: producer.id, score });
    });
    producer.on("trace", (trace) => {
      log.debug("producer_trace", { streamId, producerId: producer.id, trace });
    });
    producer.on("transportclose", () => {
      log.info("producer_transport_closed", { streamId, producerId: producer.id });
    });
    producer.on("close", () => {
      log.info("producer_closed", { streamId, producerId: producer.id });
    });
    try {
      await producer.enableTraceEvent(["rtp", "pli", "fir", "nack", "keyframe"]);
    } catch {}

    return producer.id;
  }

  /** Closes the plain transport and producer associated with a source. */
  async function closeIngest(streamId) {
    const p = ingestProducers.get(streamId);
    if (p) { try { p.close(); } catch {} }
    ingestProducers.delete(streamId);

    for (const [consumerId, entry] of consumers.entries()) {
      if (entry.streamId !== streamId) continue;
      try { entry.consumer.close(); } catch {}
      consumers.delete(consumerId);
      log.info("consumer_closed_on_ingest_close", { streamId, consumerId, transportId: entry.transportId });
    }

    const t = ingestPlainTransports.get(streamId);
    if (t) { try { t.close(); } catch {} }
    ingestPlainTransports.delete(streamId);
    log.info("ingest_closed", { streamId });
  }

  /** Creates a browser-facing WebRTC transport and tracks its lifecycle. */
  async function createWebRtcTransport() {
    const transport = await router.createWebRtcTransport({
      listenInfos: [
        {
          protocol: "udp",
          ip: "0.0.0.0",
          announcedAddress: announcedIp || undefined,
          sendBufferSize: WEBRTC_SOCKET_BUFFER_SIZE,
          recvBufferSize: WEBRTC_SOCKET_BUFFER_SIZE
        },
        {
          protocol: "tcp",
          ip: "0.0.0.0",
          announcedAddress: announcedIp || undefined,
          sendBufferSize: WEBRTC_SOCKET_BUFFER_SIZE,
          recvBufferSize: WEBRTC_SOCKET_BUFFER_SIZE
        }
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true
    });

    webRtcTransports.set(transport.id, transport);
    log.debug("webrtc_transport_created", {
      transportId: transport.id,
      iceCandidates: transport.iceCandidates?.length ?? 0,
      hasDtlsParameters: !!transport.dtlsParameters,
      socketBufferSize: WEBRTC_SOCKET_BUFFER_SIZE
    });

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

    transport.on("iceselectedtuplechange", (tuple) => {
      log.debug("ice_selected_tuple_change", { transportId: transport.id, tuple });
    });

    transport.on("trace", (trace) => {
      log.debug("webrtc_transport_trace", { transportId: transport.id, trace });
    });
    try {
      await transport.enableTraceEvent(["probation", "bwe"]);
    } catch {}

    return {
      transportId: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    };
  }

  /** Applies browser DTLS parameters to a previously created transport. */
  async function connectWebRtcTransport(transportId, dtlsParameters) {
    const t = webRtcTransports.get(transportId);
    if (!t) throw new Error("transport not found");
    await t.connect({ dtlsParameters });
    log.info("webrtc_transport_connected", {
      transportId,
      dtlsState: t.dtlsState,
      iceState: t.iceState,
      selectedTuple: t.iceSelectedTuple ?? null
    });
  }

  /** Creates a browser consumer for the selected source when codec support matches. */
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
    consumers.set(consumer.id, { consumer, streamId, transportId });
    log.debug("consumer_rtp_parameters", {
      streamId,
      transportId,
      consumerId: consumer.id,
      encodings: consumer.rtpParameters?.encodings?.length ?? 0,
      codecs: consumer.rtpParameters?.codecs?.length ?? 0
    });
    try {
      await consumer.requestKeyFrame();
      log.debug("consumer_keyframe_requested", { streamId, transportId, consumerId: consumer.id });
    } catch (error) {
      log.warn("consumer_keyframe_request_failed", {
        streamId,
        transportId,
        consumerId: consumer.id,
        error: String(error?.message || error)
      });
    }

    consumer.on("transportclose", () => {
      log.info("consumer_transport_closed", { consumerId: consumer.id, streamId, transportId });
      consumers.delete(consumer.id);
    });

    consumer.on("producerclose", () => {
      log.info("consumer_producer_closed", { consumerId: consumer.id, streamId, producerId: producer.id });
      consumers.delete(consumer.id);
    });
    consumer.on("score", (score) => {
      log.debug("consumer_score", { consumerId: consumer.id, streamId, transportId, score });
    });
    consumer.on("layerschange", (layers) => {
      log.debug("consumer_layers_change", { consumerId: consumer.id, streamId, transportId, layers });
    });
    consumer.on("trace", (trace) => {
      log.debug("consumer_trace", { consumerId: consumer.id, streamId, transportId, trace });
    });
    try {
      await consumer.enableTraceEvent(["rtp", "pli", "fir", "nack", "keyframe"]);
    } catch {}

    return {
      consumerId: consumer.id,
      producerId: producer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters
    };
  }

  /** Returns a diagnostic summary of SFU transports, producers, and consumers. */
  function debugSnapshot() {
    const ingest = [];
    for (const [streamId, plain] of ingestPlainTransports.entries()) {
      const producer = ingestProducers.get(streamId);
      ingest.push({
        streamId,
        plainTransport: {
          id: plain.id,
          tuple: plain.tuple ?? null,
          rtcpTuple: plain.rtcpTuple ?? null
        },
        producer: producer ? {
          id: producer.id,
          paused: !!producer.paused,
          score: producer.score ?? null
        } : null
      });
    }

    const transports = [];
    for (const [transportId, transport] of webRtcTransports.entries()) {
      transports.push({
        transportId,
        iceState: transport.iceState,
        dtlsState: transport.dtlsState,
        selectedTuple: transport.iceSelectedTuple ?? null
      });
    }

    const consumersOut = [];
    for (const [consumerId, entry] of consumers.entries()) {
      consumersOut.push({
        consumerId,
        streamId: entry.streamId,
        transportId: entry.transportId,
        kind: entry.consumer.kind,
        paused: !!entry.consumer.paused,
        producerPaused: !!entry.consumer.producerPaused,
        score: entry.consumer.score ?? null,
        currentLayers: entry.consumer.currentLayers ?? null
      });
    }

    return {
      workerPid: worker.pid,
      ingestCount: ingest.length,
      transportCount: transports.length,
      consumerCount: consumersOut.length,
      ingest,
      transports,
      consumers: consumersOut
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
    consume,
    debugSnapshot
  };
}
