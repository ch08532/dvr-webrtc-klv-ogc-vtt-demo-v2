import { monitorEventLoopDelay, performance } from "node:perf_hooks";
/** Collects lightweight host and Node process metrics for the status endpoint. */
import os from "node:os";
import { execFile } from "node:child_process";

const lagHistogram = monitorEventLoopDelay({ resolution: 20 });
lagHistogram.enable();
let eluPrev = performance.eventLoopUtilization();
let previousCpuTicks = null;
const IO_NETWORK_REFRESH_MS = 1_500;
let ioNetworkLastAttemptMs = 0;
let ioNetworkRefreshPending = false;
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
