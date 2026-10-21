import { describe, expect, it, vi } from "vitest";
import { sessionCleanup } from "../src/terminal/process-session.js";

describe("terminal kernel-session cleanup", () => {
  it("kills reparented jobs in their original session, excludes unrelated/server PIDs, and is idempotent", () => {
    const signal = vi.fn();
    const sessionOf = (pid: number) => ([400, 401].includes(pid) ? 400 : 900);
    const cleanup = sessionCleanup(
      400,
      900,
      () => [400, 401, 902, process.pid, 1, NaN],
      sessionOf,
      signal
    );
    cleanup();
    cleanup();
    expect(signal.mock.calls.map(([pid]) => pid)).toEqual([400, 401]);
  });
  it("revalidates immediately before signaling and rejects unsafe session IDs", () => {
    const signal = vi.fn();
    const sessionOf = vi.fn().mockReturnValueOnce(400).mockReturnValueOnce(999);
    sessionCleanup(400, 900, () => [401], sessionOf, signal)();
    expect(signal).not.toHaveBeenCalled();
    for (const id of [0, 1, NaN, 900])
      expect(() =>
        sessionCleanup(
          id,
          900,
          () => [],
          () => 0,
          signal
        )
      ).toThrow();
  });
});
