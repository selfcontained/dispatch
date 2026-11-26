import { gitSha, packageVersion } from "../src/generated/runtime-assets.js";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cpuPercentage,
  runnerHealthSampler,
} from "../../../packages/runner/src/workload/agents/remote/health.js";
import { RemoteRunnerService } from "../src/agents/remote/service.js";
import { parseRunnerHealth } from "@dispatch/runner-protocol";

describe("runner health samples", () => {
  const reading = { scope: "quota-2", used: 10, total: 100 };
  it("reports CPU across comparable sample intervals", () => {
    expect(cpuPercentage(undefined, reading)).toBeNull();
    expect(cpuPercentage(reading, { ...reading, used: 30, total: 180 })).toBe(
      25
    );
    expect(cpuPercentage(reading, { ...reading, scope: "host" })).toBeNull();
  });
  it("bounds counters and stores only portable reported fields", () => {
    const sample = {
      version: "1.2.3",
      sessions: 2,
      working: 1,
      cpuPercent: null,
      memoryUsed: 5,
      memoryTotal: 10,
    };
    expect(parseRunnerHealth({ ...sample, arbitrary: true })).toEqual(sample);
    const maintenanceFailure = {
      step: "signal",
      exitCode: 1,
      at: "2026-01-10T12:00:00Z",
    };
    expect(
      parseRunnerHealth({
        ...sample,
        revision: "0123abcd",
        maintenanceFailure: { ...maintenanceFailure, stderr: "private" },
      })
    ).toEqual({ ...sample, revision: "0123abcd", maintenanceFailure });
    expect(
      parseRunnerHealth({
        ...sample,
        revision: "untrusted text",
        maintenanceFailure: { ...maintenanceFailure, step: "private" },
      })
    ).toEqual(sample);
    for (const update of [
      { sessions: -1 },
      { working: 3 },
      { cpuPercent: Infinity },
      { version: "bad\nversion" },
      { memoryUsed: 11 },
    ]) {
      expect(parseRunnerHealth({ ...sample, ...update })).toBeNull();
    }
  });
});

describe("the last maintenance failure", () => {
  let runtime: string;
  beforeEach(async () => {
    runtime = await mkdtemp(path.join(os.tmpdir(), "dispatch-runner-health-"));
  });
  afterEach(() => rm(runtime, { recursive: true, force: true }));

  const failure = { step: "stage", exitCode: 1, at: "2026-01-10T12:00:00Z" };
  async function reported(installedAt?: string) {
    await writeFile(
      path.join(runtime, "last-maintenance-failure.json"),
      JSON.stringify(failure)
    );
    if (installedAt) {
      const file = path.join(runtime, "installed-release");
      await writeFile(file, "1:2 v1.2.3\n");
      await utimes(file, new Date(installedAt), new Date(installedAt));
    }
    return (
      await runnerHealthSampler(runtime, {
        version: packageVersion,
        revision: gitSha,
      })([])
    ).maintenanceFailure;
  }

  it("is superseded by a build installed after it", async () => {
    expect(await reported("2026-01-10T12:00:01.000Z")).toBeUndefined();
  });

  it.each([
    ["no build was recorded", undefined],
    ["the build is older", "2026-01-10T11:59:00.000Z"],
    // The record truncates to seconds, so this build may be the older.
    ["both fall in one second", "2026-01-10T12:00:00.900Z"],
  ])("is reported when %s", async (_case, installedAt) => {
    expect(await reported(installedAt)).toEqual(failure);
  });
});

describe("a runner's health reports", () => {
  it("serves the latest sample and stores at most one a second", async () => {
    const service = new RemoteRunnerService();
    const recordHealth = vi.fn(async () => {});
    const registration = {
      id: "rnr_one",
      name: "one",
      enrolled: true,
      workspaces: [],
    };
    Object.assign(service as any, {
      enrollment: {
        registry: {
          recordHealth,
          seen: async () => {},
          list: async () => [registration],
        },
      },
    });
    const socket = Object.assign(
      new Duplex({ read() {}, write: (_chunk, _encoding, done) => done() }),
      { setKeepAlive() {} }
    );
    (service as any).attachPeer(socket, {
      key: registration.id,
      registrationId: registration.id,
      approved: () => true,
      allows: () => true,
    });
    const send = (frame: object) => socket.push(JSON.stringify(frame) + "\n");
    send({ type: "ready", version: 1, workspaces: ["work"], health: true });
    for (const sessions of [1, 2])
      send({
        type: "health",
        sample: {
          version: "1.2.3",
          sessions,
          working: 0,
          cpuPercent: null,
          memoryUsed: 1,
          memoryTotal: 2,
        },
      });
    await vi.waitFor(async () =>
      expect((await service.list())[0]?.health?.sessions).toBe(2)
    );
    expect(recordHealth).toHaveBeenCalledOnce();
    socket.destroy();
  });
});
