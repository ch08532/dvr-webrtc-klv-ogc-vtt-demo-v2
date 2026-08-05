import { monitorEventLoopDelay, performance } from "node:perf_hooks";
/** Collects lightweight host and Node process metrics for the status endpoint. */
import os from "node:os";
import { execFile } from "node:child_process";

const lagHistogram = monitorEventLoopDelay({ resolution: 20 });
lagHistogram.enable();
let eluPrev = performance.eventLoopUtilization();
let previousCpuTicks = null;
const IO_NETWORK_REFRESH_MS = 1_500;
const PROCESS_CPU_CACHE_MS = 1_000;
let ioNetworkLastAttemptMs = 0;
let ioNetworkRefreshPending = false;
let processCpuCache = { expiresAt: 0, values: new Map() };
let processCpuRefresh = null;
const previousProcessCpuSamples = new Map();
let ioNetworkMetrics = {
  disk: { readBytesPerSec: null, writeBytesPerSec: null, available: false },
  network: { receiveBytesPerSec: null, transmitBytesPerSec: null, available: false },
  updatedAt: null
};

const WINDOWS_IO_NETWORK_SCRIPT = [
  "$disk = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_PhysicalDisk -ErrorAction Stop | Where-Object { $_.Name -eq '_Total' } | Select-Object -First 1;",
  "$interfaces = Get-CimInstance -ClassName Win32_PerfFormattedData_Tcpip_NetworkInterface -ErrorAction Stop | Where-Object { $_.Name -notmatch 'Loopback|Teredo|isatap' };",
  "$received = [double](($interfaces | Measure-Object -Property BytesReceivedPersec -Sum).Sum);",
  "$sent = [double](($interfaces | Measure-Object -Property BytesSentPersec -Sum).Sum);",
  "[pscustomobject]@{ diskReadBytesPerSec = [double]$disk.DiskReadBytesPerSec; diskWriteBytesPerSec = [double]$disk.DiskWriteBytesPerSec; networkReceiveBytesPerSec = $received; networkTransmitBytesPerSec = $sent } | ConvertTo-Json -Compress"
].join(" ");

/** Returns cumulative CPU time for the requested Windows process IDs. */
function windowsProcessCpuScript(pids) {
  const idList = pids.join(",");
  return [
    `$pids = @(${idList});`,
    "Get-Process -Id $pids -ErrorAction SilentlyContinue |",
    "Select-Object Id,CPU | ConvertTo-Json -Compress"
  ].join(" ");
}

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

function finiteMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      timeout: 2_000,
      windowsHide: true,
      maxBuffer: 128 * 1024
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

/** Samples Windows formatted performance counters without delaying API responses. */
async function refreshIoNetworkMetrics() {
  if (process.platform !== "win32") return;
  try {
    const output = await runPowerShell(WINDOWS_IO_NETWORK_SCRIPT);
    const sample = JSON.parse(String(output || "{}"));
    const diskReadBytesPerSec = finiteMetric(sample.diskReadBytesPerSec);
    const diskWriteBytesPerSec = finiteMetric(sample.diskWriteBytesPerSec);
    const networkReceiveBytesPerSec = finiteMetric(sample.networkReceiveBytesPerSec);
    const networkTransmitBytesPerSec = finiteMetric(sample.networkTransmitBytesPerSec);
    ioNetworkMetrics = {
      disk: {
        readBytesPerSec: diskReadBytesPerSec,
        writeBytesPerSec: diskWriteBytesPerSec,
        available: diskReadBytesPerSec != null || diskWriteBytesPerSec != null
      },
      network: {
        receiveBytesPerSec: networkReceiveBytesPerSec,
        transmitBytesPerSec: networkTransmitBytesPerSec,
        available: networkReceiveBytesPerSec != null || networkTransmitBytesPerSec != null
      },
      updatedAt: new Date().toISOString()
    };
  } catch {
    // These counters are unavailable on some locked-down Windows hosts. Keep
    // the existing sample (or n/a) rather than making health requests fail.
  }
}

function scheduleIoNetworkMetricsRefresh() {
  const now = Date.now();
  if (process.platform !== "win32" || ioNetworkRefreshPending || now - ioNetworkLastAttemptMs < IO_NETWORK_REFRESH_MS) return;
  ioNetworkLastAttemptMs = now;
  ioNetworkRefreshPending = true;
  void refreshIoNetworkMetrics().finally(() => { ioNetworkRefreshPending = false; });
}

/**
 * Returns Task-Manager-style CPU utilization for selected processes. Windows
 * exposes cumulative process CPU seconds through Get-Process, so two samples
 * are compared and normalized by elapsed wall time and logical CPU count.
 */
export async function getProcessCpuPercents(pids) {
  const uniquePids = [...new Set((Array.isArray(pids) ? pids : [])
    .map((pid) => Number(pid))
    .filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (!uniquePids.length) return new Map();
  if (process.platform !== "win32") return new Map(uniquePids.map((pid) => [pid, null]));

  const now = Date.now();
  if (now >= processCpuCache.expiresAt && !processCpuRefresh) {
    processCpuRefresh = runPowerShell(windowsProcessCpuScript(uniquePids))
      .then((output) => {
        const parsed = JSON.parse(String(output || "[]"));
        const rows = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
        const sampledAtMs = Date.now();
        const logicalProcessors = Math.max(1, os.cpus().length);
        const values = new Map(rows.map((row) => {
          const pid = Number(row?.Id);
          const cpuSeconds = Number(row?.CPU);
          const previous = previousProcessCpuSamples.get(pid);
          const elapsedSeconds = previous ? (sampledAtMs - previous.sampledAtMs) / 1000 : 0;
          const cpuSecondsDelta = previous ? cpuSeconds - previous.cpuSeconds : 0;
          const cpuPercent = Number.isFinite(cpuSeconds) && elapsedSeconds > 0 && cpuSecondsDelta >= 0
            ? Number(Math.max(0, Math.min(100, (cpuSecondsDelta / elapsedSeconds / logicalProcessors) * 100)).toFixed(1))
            : null;
          if (Number.isInteger(pid) && Number.isFinite(cpuSeconds)) {
            previousProcessCpuSamples.set(pid, { cpuSeconds, sampledAtMs });
          }
          return [pid, cpuPercent];
        }));
        processCpuCache = { expiresAt: Date.now() + PROCESS_CPU_CACHE_MS, values };
      })
      .catch(() => {
        processCpuCache = { expiresAt: Date.now() + PROCESS_CPU_CACHE_MS, values: new Map() };
      })
      .finally(() => { processCpuRefresh = null; });
  }
  if (processCpuRefresh) await processCpuRefresh;
  return new Map(uniquePids.map((pid) => [pid, processCpuCache.values.get(pid) ?? null]));
}

/** Returns a point-in-time metrics object for the UI and diagnostics. */
export function getRuntimeMetricsSnapshot() {
  scheduleIoNetworkMetricsRefresh();
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
      },
      disk: ioNetworkMetrics.disk,
      network: ioNetworkMetrics.network,
      ioNetworkUpdatedAt: ioNetworkMetrics.updatedAt
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
