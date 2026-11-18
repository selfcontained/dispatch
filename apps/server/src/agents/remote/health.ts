import os from "node:os";
import path from "node:path";
import { readFile, lstat } from "node:fs/promises";
import { packageVersion } from "../../generated/runtime-assets.js";
import type { RunnerHealth } from "./protocol.js";

async function readMetric(file: string) {
  return (await readFile(file, "utf8").catch(() => "")).trim();
}

type CpuReading = { scope: string; used: number; total: number };

export function cpuPercentage(
  previous: CpuReading | undefined,
  next: CpuReading
) {
  if (
    !previous ||
    previous.scope !== next.scope ||
    next.total <= previous.total ||
    next.used < previous.used
  )
    return null;
  return Math.round(
    Math.min(
      100,
      (100 * (next.used - previous.used)) / (next.total - previous.total)
    )
  );
}

/** For cgroup v2, find the visible group, including container namespace roots. */
async function cgroupDirectory() {
  const relative = (await readMetric("/proc/self/cgroup")).match(
    /^0::(\/.*)$/m
  )?.[1];
  if (!relative) return null;
  const root = "/sys/fs/cgroup";
  const candidate = path.join(root, path.resolve("/", relative));
  if (await lstat(path.join(candidate, "cpu.stat")).catch(() => null))
    return candidate;
  return root;
}

export function runnerHealthSampler() {
  const group = cgroupDirectory();
  let previous: CpuReading | undefined;
  return async (liveHostDirs: string[]): Promise<RunnerHealth> => {
    const dir = await group;
    const [quota, usage, memMax, memCurrent, working] = await Promise.all([
      dir && readMetric(path.join(dir, "cpu.max")),
      dir && readMetric(path.join(dir, "cpu.stat")),
      dir && readMetric(path.join(dir, "memory.max")),
      dir && readMetric(path.join(dir, "memory.current")),
      Promise.all(
        liveHostDirs.map((d) =>
          lstat(path.join(d, "turn-active")).then(
            (s) => s.isFile(),
            () => false
          )
        )
      ),
    ]);
    const [limit, period] = (quota ?? "").split(" ").map(Number);
    const usageMatch = usage?.match(/^usage_usec (\d+)$/m);
    let cpu: CpuReading;
    if (usageMatch && limit && limit > 0 && period && period > 0) {
      const capacity = Math.min(os.availableParallelism(), limit / period);
      cpu = {
        scope: `quota-${capacity}`,
        used: Number(usageMatch[1]),
        total: performance.now() * 1000 * capacity,
      };
    } else {
      const aggregate = os.cpus().reduce(
        (sum, c) => {
          const { idle, user, nice, sys, irq } = c.times;
          sum.used += user + nice + sys + irq;
          sum.total += user + nice + sys + irq + idle;
          return sum;
        },
        { used: 0, total: 0 }
      );
      cpu = { scope: "host", ...aggregate };
    }
    const cpuPercent = cpuPercentage(previous, cpu);
    previous = cpu;
    const hostTotal = os.totalmem();
    const limited =
      Number(memMax) > 0 && Number(memMax) <= hostTotal && !!memCurrent;
    const memoryTotal = limited ? Number(memMax) : hostTotal;
    const memoryUsed = limited ? Number(memCurrent) : hostTotal - os.freemem();
    return {
      version: packageVersion,
      sessions: liveHostDirs.length,
      working: working.filter(Boolean).length,
      cpuPercent,
      memoryTotal,
      memoryUsed: Math.max(0, Math.min(memoryUsed, memoryTotal)),
    };
  };
}
