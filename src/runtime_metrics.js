import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const lagHistogram = monitorEventLoopDelay({ resolution: 20 });
lagHistogram.enable();
let eluPrev = performance.eventLoopUtilization();

function nsToMs(value) {
  return Number(value) / 1e6;
}

function safeMs(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 60_000) return 0;
  return Number(value.toFixed(3));
}

export function getRuntimeMetricsSnapshot() {
  const eluNow = performance.eventLoopUtilization(eluPrev);
  eluPrev = performance.eventLoopUtilization();

  const eventLoopLagMs = {
    min: safeMs(nsToMs(lagHistogram.min)),
    max: safeMs(nsToMs(lagHistogram.max)),
    mean: safeMs(nsToMs(lagHistogram.mean)),
    stddev: safeMs(nsToMs(lagHistogram.stddev)),
    p50: safeMs(nsToMs(lagHistogram.percentile(50))),
    p95: safeMs(nsToMs(lagHistogram.percentile(95))),
    p99: safeMs(nsToMs(lagHistogram.percentile(99)))
  };

  return {
    timestampIso: new Date().toISOString(),
    process: {
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      eventLoopUtilization: {
        idle: safeMs(eluNow.idle),
        active: safeMs(eluNow.active),
        utilization: safeMs(eluNow.utilization)
      },
      eventLoopLagMs
    }
  };
}
