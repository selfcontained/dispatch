import { createHash } from "node:crypto";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionFileSource } from "../src/files/session-file.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "session-file-source-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

describe("sessionFileSource", () => {
  it("checks the file up front and fails as before when it is missing", async () => {
    await expect(
      sessionFileSource(path.join(dir, "missing.txt"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("streams and reads the bytes it was made for", async () => {
    const file = path.join(dir, "notes.txt");
    await writeFile(file, "notes ✓");
    const plain = await sessionFileSource(file);
    expect(plain.size).toBe(Buffer.byteLength("notes ✓"));
    expect((await buffer(plain.open())).toString()).toBe("notes ✓");
    expect((await plain.read()).toString()).toBe("notes ✓");
    const guarded = await sessionFileSource(file, sha256("notes ✓"));
    expect((await buffer(guarded.open())).toString()).toBe("notes ✓");
  });

  it("refuses a file replaced or changed after it was checked", async () => {
    const file = path.join(dir, "notes.txt");
    await writeFile(file, "first");
    const replaced = await sessionFileSource(file);
    const other = path.join(dir, "other.txt");
    await writeFile(other, "second");
    await rename(other, file);
    await expect(buffer(replaced.open())).rejects.toThrow(
      "Session file changed during transfer"
    );

    const changed = await sessionFileSource(file, sha256("second"));
    await writeFile(file, "third!");
    await expect(buffer(changed.open())).rejects.toThrow(
      "Session file changed during transfer"
    );
    await expect(changed.read()).rejects.toThrow(
      "Session file changed during transfer"
    );
  });
});
