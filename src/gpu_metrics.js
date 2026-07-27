/** Queries NVIDIA GPU utilization for the runtime status endpoint. */
import { execFile } from "node:child_process";

const CACHE_MS = 1_000;
const NVIDIA_SMI_ARGS = [
  "--query-gpu=name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu",
  "--format=csv,noheader,nounits"
];

let cached = { expiresAt: 0, value: { available: false, gpus: [] } };
let pending = null;

/** Converts a command-line metric field to a number, if possible. */
function parseNumber(value) {
  const number = Number(String(value || "").trim());
  return Number.isFinite(number) ? number : null;
}

/** Runs nvidia-smi and resolves the selected utilization metrics. */
function queryNvidiaSmi() {
  return new Promise((resolve) => {
    execFile("nvidia-smi", NVIDIA_SMI_ARGS, { timeout: 2_000, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve({ available: false, gpus: [] });
        return;
      }

      const gpus = String(stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [name, utilizationPercent, memoryUtilizationPercent, memoryUsedMiB, memoryTotalMiB, temperatureC] = line.split(",");
          return {
            name: String(name || "").trim() || "NVIDIA GPU",
            utilizationPercent: parseNumber(utilizationPercent),
            memoryUtilizationPercent: parseNumber(memoryUtilizationPercent),
            memoryUsedMiB: parseNumber(memoryUsedMiB),
            memoryTotalMiB: parseNumber(memoryTotalMiB),
            temperatureC: parseNumber(temperatureC)
          };
        });
      resolve({ available: gpus.length > 0, gpus });
    });
  });
}

/** Returns GPU metrics when available, otherwise a non-fatal unavailable result. */
export async function getGpuMetrics() {
  if (Date.now() < cached.expiresAt) return cached.value;
  if (pending) return pending;

  pending = queryNvidiaSmi()
    .then((value) => {
      cached = { expiresAt: Date.now() + CACHE_MS, value };
      return value;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}
