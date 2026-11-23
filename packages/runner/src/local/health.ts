import { cpus, freemem, totalmem } from "node:os";
import type { Infer, healthSample } from "@dispatch/runner-protocol/contract";

type HealthSample = Infer<typeof healthSample>;
type Build = { version: string; revision?: string };

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    const { user, nice, sys, irq } = cpu.times;
    idle += cpu.times.idle;
    total += user + nice + sys + irq + cpu.times.idle;
  }
  return { idle, total };
}

/**
 * Machine health. CPU is the busy share since the previous sample (or since
 * the runner started). The child runs no sessions until a session family
 * moves into it, so `sessions` and `working` are its own: zero.
 */
export function healthSampler(build: Build): () => HealthSample {
  let previous = cpuTimes();
  return () => {
    const now = cpuTimes();
    const total = now.total - previous.total;
    const cpuPercent =
      total > 0
        ? Math.round((1 - (now.idle - previous.idle) / total) * 1000) / 10
        : null;
    previous = now;
    const memoryTotal = totalmem();
    return {
      version: build.version,
      ...(build.revision && { revision: build.revision }),
      sessions: 0,
      working: 0,
      cpuPercent,
      memoryUsed: memoryTotal - freemem(),
      memoryTotal,
    };
  };
}
