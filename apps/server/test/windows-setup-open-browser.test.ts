import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  browserCommand,
  openBrowser,
} from "../src/windows-setup/open-browser.js";

describe("browserCommand", () => {
  it("builds the Windows start command", () => {
    expect(browserCommand("http://127.0.0.1:5/setup", "win32")).toEqual({
      command: "cmd.exe",
      args: ["/c", "start", "", "http://127.0.0.1:5/setup"],
    });
  });

  it("uses open on macOS and xdg-open elsewhere", () => {
    expect(browserCommand("http://x", "darwin")).toEqual({
      command: "open",
      args: ["http://x"],
    });
    expect(browserCommand("http://x", "linux")).toEqual({
      command: "xdg-open",
      args: ["http://x"],
    });
  });
});

describe("openBrowser", () => {
  function fakeSpawn(event: "spawn" | "error") {
    return vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & { unref(): void };
      child.unref = () => {};
      queueMicrotask(() => child.emit(event, new Error("ENOENT")));
      return child;
    });
  }

  it("spawns the launcher detached and resolves", async () => {
    const spawn = fakeSpawn("spawn");
    await expect(
      openBrowser("http://x", { platform: "win32", spawn: spawn as never })
    ).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledWith(
      "cmd.exe",
      ["/c", "start", "", "http://x"],
      expect.objectContaining({
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      })
    );
  });

  it("never rejects when the launcher fails", async () => {
    await expect(
      openBrowser("http://x", {
        platform: "linux",
        spawn: fakeSpawn("error") as never,
      })
    ).resolves.toBeUndefined();
  });
});
