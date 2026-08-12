import { Router } from "express";

/**
 * Runtime observability endpoints.
 *
 * `/metrics/runtime` is a detailed operator snapshot; `/healthz` is the
 * smaller readiness signal for service monitoring. Neither mutates sources.
 */
export function createMetricsRouter({
  getRuntimeMetricsSnapshot, getGpuMetrics, sfuClient, sources, sourceStates,
  isProcessRunning, getProcessCpuPercents, httpPort, wsPath, mediaTools
}) {
  const router = Router();
  // Sample GPU, SFU, and process data on demand so values remain current.
  router.get("/metrics/runtime", async (_req, res) => {
    const runtime = getRuntimeMetricsSnapshot();
    runtime.host.gpu = await getGpuMetrics();
    let sfuHealth = null; let sfuError = null;
    try { sfuHealth = await sfuClient.health(); } catch (error) { sfuError = String(error?.message || error); }
    const klvWorkers = [...sources.values()].map((source) => ({
      streamId: source.streamId, pid: source.klvWorker?.proc?.pid ?? null,
      connected: !!source.klvWorker?.proc?.connected, running: isProcessRunning(source.klvWorker?.proc),
      exitCode: source.klvWorker?.proc?.exitCode ?? null
    }));
    const mediaProcesses = [
      { role: "Server", pid: process.pid },
      ...[...sources.values()].flatMap((source) => [
        isProcessRunning(source.hls?.proc) ? { role: "FFmpeg HLS", streamId: source.streamId, pid: source.hls.proc.pid } : null,
        isProcessRunning(source.klvWorker?.proc) ? { role: "KLV worker", streamId: source.streamId, pid: source.klvWorker.proc.pid } : null
      ]).filter(Boolean),
      Number.isInteger(Number(sfuHealth?.pid)) ? { role: "SFU worker", pid: Number(sfuHealth.pid) } : null,
      Number.isInteger(Number(sfuHealth?.webrtc?.workerPid)) ? { role: "mediasoup worker", pid: Number(sfuHealth.webrtc.workerPid) } : null
    ].filter(Boolean);
    const processCpuPercents = await getProcessCpuPercents(mediaProcesses.map((entry) => entry.pid));
    res.json({
      ...runtime,
      processes: mediaProcesses.map((entry) => ({ ...entry, cpuPercent: processCpuPercents.get(entry.pid) ?? null })),
      server: { httpPort, wsPath, activeSources: sources.size, statesTracked: sourceStates.size },
      workers: { sfu: sfuError ? { ok: false, error: sfuError } : { ok: true, ...sfuHealth }, klv: klvWorkers },
      mediaTools
    });
  });
  // Health fails when required media tooling or the SFU is unavailable.
  router.get("/healthz", async (_req, res) => {
    const runtime = getRuntimeMetricsSnapshot();
    const degradedOrError = [...sourceStates.values()].filter((state) => state.state === "degraded" || state.state === "error").length;
    let sfuOk = true; let sfuInfo = null; let sfuError = null;
    try { sfuInfo = await sfuClient.health(); } catch (error) { sfuOk = false; sfuError = String(error?.message || error); }
    const ok = sfuOk && mediaTools.ok;
    res.status(ok ? 200 : 503).json({
      ok, timestampIso: new Date().toISOString(), activeSources: sources.size, degradedOrErrorSources: degradedOrError,
      eventLoopLagP99Ms: runtime.process.eventLoopLagMs.p99, mediaTools,
      sfu: sfuOk ? { ok: true, pid: sfuInfo?.pid ?? null, ingestCount: sfuInfo?.ingestCount ?? 0 } : { ok: false, error: sfuError }
    });
  });
  return router;
}
