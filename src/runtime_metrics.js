import { monitorEventLoopDelay, performance } from "node:perf_hooks";
/** Collects lightweight host and Node process metrics for the status endpoint. */
import os from "node:os";

const lagHistogram = monitorEventLoopDelay({ resolution: 20 });
lagHistogram.enable();
let eluPrev = performance.eventLoopUtilization();
let previousCpuTicks = null;

/** Converts a Node high-resolution timer tuple to milliseconds. */
function nsToMs(value) {
  return Number(value) / 1e6;
}

/** Rounds a finite duration for display and omits invalid values. */
function safeMs(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 60_000) return 0;
  return Number(value.toFixed(3));
}

/** Estimates current host CPU utilization from cumulative CPU times. */
function hostCpuPercent() {
  const ticks = os.cpus().reduce((total, cpu) => {
    total.idle += cpu.times.idle;
    total.total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    return total;
  }, { idle: 0, total: 0 });

  const previous = previousCpuTicks;
  previousCpuTicks = ticks;
  if (!previous) return null;
  const totalDelta = ticks.total - previous.total;
  const idleDelta = ticks.idle - previous.idle;
  if (totalDelta <= 0) return null;
  return Number(Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100)).toFixed(1));
}

/** Returns a point-in-time metrics object for the UI and diagnostics. */
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
    host: {
      cpuPercent: hostCpuPercent(),
      memory: {
        totalBytes: os.totalmem(),
        freeBytes: os.freemem(),
        usedBytes: os.totalmem() - os.freemem(),
        usedPercent: Number((((os.totalmem() - os.freemem()) / os.totalmem()) * 100).toFixed(1))
      }
    },
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
