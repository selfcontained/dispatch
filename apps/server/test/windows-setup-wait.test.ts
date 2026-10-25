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
});
