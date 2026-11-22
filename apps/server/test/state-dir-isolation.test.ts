import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { stateDir } from "../src/state-dir.js";

// Guard: tests must never write to the machine's real ~/.dispatch install
// directory. vitest.config.ts points DISPATCH_STATE_DIR at a per-run temp dir.
describe("test state dir isolation", () => {
  it("resolves the state dir outside the real home directory", () => {
    const real = path.join(os.homedir(), ".dispatch");
    expect(process.env.DISPATCH_STATE_DIR).toBeTruthy();
    expect(path.resolve(stateDir())).not.toBe(real);
    expect(path.resolve(stateDir()).startsWith(real + path.sep)).toBe(false);
  });
});
