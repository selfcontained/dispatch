import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mock.spawn,
}));
import { observedUpdateRunner } from "../src/agents/engine-updates.js";
function child() {
  const value = Object.assign(new EventEmitter(), {
    pid: 88888,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  mock.spawn.mockReturnValue(value);
  return value;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("bounded gated update runner", () => {
  it("does not release the verified command until its PID is durably recorded", async () => {
    const process = child();
    const input = vi.spyOn(process.stdin, "end");
    let release!: () => void;
    const persisted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const output = vi.fn();
    const spawned = vi.fn(() => persisted);
    const result = observedUpdateRunner({ spawned, output })(
      "/verified/npm",
      ["install", "literal;$(evil)"],
      { timeoutMs: 1000 }
    );
    expect(spawned).toHaveBeenCalledWith(88888);
    expect(input).not.toHaveBeenCalled();
    expect(mock.spawn.mock.calls.at(-1)?.[1]).toEqual([
      "-c",
      'IFS= read -r dispatch_start || exit 1; [ "$dispatch_start" = start ] || exit 1; exec "$@" </dev/null',
      "dispatch-engine-update",
      "/verified/npm",
      "install",
      "literal;$(evil)",
    ]);
    release();
    await Promise.resolve();
    expect(input).toHaveBeenCalledWith("start\n");
    process.stdout.write("x".repeat(100_000));
    process.stderr.write("stderr");
    process.emit("close", 0);
    expect(await result).toMatchObject({
      exitCode: 0,
      stdout: "x".repeat(32_000),
      stderr: "stderr",
    });
    expect(output).toHaveBeenCalledWith("stderr");
  });
  it("withholds the token and kills only the newly owned process group if persistence fails", async () => {
    const process = child();
    const end = vi.spyOn(process.stdin, "end");
    const kill = vi.spyOn(globalThis.process, "kill").mockReturnValue(true);
    const result = observedUpdateRunner({
      spawned: async () => {
        throw new Error("DB unavailable");
      },
    })("/verified/npm", []);
    const failed = expect(result).rejects.toThrow("DB unavailable");
    await Promise.resolve();
    expect(end).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith(-88888, "SIGKILL");
    process.emit("close", 1);
    await failed;
  });
  it("times out the owned process group and cannot report success even if close says zero", async () => {
    vi.useFakeTimers();
    const process = child();
    const kill = vi.spyOn(globalThis.process, "kill").mockReturnValue(true);
    const result = observedUpdateRunner()("/verified/npm", [], {
      timeoutMs: 120_000,
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(kill).toHaveBeenCalledWith(-88888, "SIGKILL");
    process.emit("close", 0);
    expect(await result).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("timed out after 120 seconds"),
    });
  });
});
