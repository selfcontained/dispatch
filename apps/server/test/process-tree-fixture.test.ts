import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readFixturePid,
  waitForFixturePid,
} from "./helpers/process-tree-fixture.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync("/tmp/dispatch-pid-publication-");
  file = path.join(dir, "ready");
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("process-tree fixture PID publication", () => {
  it.each([
    "",
    " ",
    "123",
    "123junk\n",
    "123\n456\n",
    "0\n",
    "-123\n",
    "NaN\n",
    "1.5\n",
    "1e3\n",
    "9007199254740993\n",
    "2147483648\n",
  ])(
    "rejects incomplete or invalid content %j without accepting numeric prefixes",
    (contents) => {
      writeFileSync(file, contents);
      expect(readFixturePid(file)).toBeUndefined();
    }
  );

  it("waits through empty and partial publication until a complete PID is atomically visible", async () => {
    vi.useFakeTimers();
    let observed: number | undefined;
    const waiting = waitForFixturePid(file).then((pid) => {
      observed = pid;
      return pid;
    });
    for (const contents of ["", "123", "123junk\n", "0\n"]) {
      writeFileSync(file, contents);
      await vi.advanceTimersByTimeAsync(20);
      expect(observed).toBeUndefined();
    }
    // Complete data in the temporary file must not mark the target ready.
    writeFileSync(`${file}.tmp`, "12345\n");
    await vi.advanceTimersByTimeAsync(20);
    expect(observed).toBeUndefined();
    renameSync(`${file}.tmp`, file);
    await vi.advanceTimersByTimeAsync(20);
    await expect(waiting).resolves.toBe(12345);
  });
});
