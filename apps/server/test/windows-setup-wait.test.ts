import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { waitForEnter } from "../src/windows-setup/run-setup-mode.js";

describe("waitForEnter", () => {
  it("prints the prompt and resolves once a line arrives", async () => {
    const log: string[] = [];
    const stdin = new PassThrough();
    let settled = false;
    const waiting = waitForEnter(
      "Dispatch failed to start. Press Enter to close this window.",
      { log: (line) => log.push(line), stdin }
    ).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(log).toEqual([
      "Dispatch failed to start. Press Enter to close this window.",
    ]);
    expect(settled).toBe(false);
    stdin.write("\n");
    await waiting;
    expect(settled).toBe(true);
  });

  it("resolves when stdin ends without input", async () => {
    const stdin = new PassThrough();
    const waiting = waitForEnter("Press Enter", { log: () => {}, stdin });
    stdin.end();
    await expect(waiting).resolves.toBeUndefined();
  });
});

describe("holdConsoleOnFailure", () => {
  it("runs the work and returns its result", async () => {
    const { holdConsoleOnFailure } =
      await import("../src/windows-setup/run-setup-mode.js");
    await expect(
      holdConsoleOnFailure(async () => "ok", { hold: async () => {} })
    ).resolves.toBe("ok");
  });

  it("logs the error, holds the console, and sets the exit code", async () => {
    const { holdConsoleOnFailure } =
      await import("../src/windows-setup/run-setup-mode.js");
    const log: string[] = [];
    let held = false;
    const previous = process.exitCode;
    try {
      await holdConsoleOnFailure(
        async () => {
          throw new Error("listen EADDRINUSE");
        },
        {
          log: (line) => log.push(line),
          hold: async () => {
            held = true;
          },
        }
      );
      expect(log).toEqual(["Dispatch failed to start: listen EADDRINUSE"]);
      expect(held).toBe(true);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previous;
    }
  });
});
