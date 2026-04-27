import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const BIN = path.join(REPO_ROOT, "bin", "embed-assisted-update.ts");

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("bin/embed-assisted-update.ts", () => {
  it("validates metadata in check-only mode", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dispatch-assisted-"));
    tmpDirs.push(dir);
    const metadataPath = path.join(dir, "meta.json");
    await writeFile(
      metadataPath,
      JSON.stringify({
        mode: "required",
        title: "Migration",
        summary: "Run a migration before restart.",
      }),
      "utf8"
    );

    expect(() =>
      execFileSync(
        "pnpm",
        ["tsx", BIN, "--check-only", "--metadata", metadataPath],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        }
      )
    ).not.toThrow();
  });

  it("embeds canonical metadata into release notes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dispatch-assisted-"));
    tmpDirs.push(dir);
    const metadataPath = path.join(dir, "meta.json");
    const notesPath = path.join(dir, "notes.md");
    await writeFile(
      metadataPath,
      JSON.stringify({
        mode: "required",
        title: "Migration",
        summary: "Run a migration before restart.",
        requiredChecks: ["service_restarted"],
      }),
      "utf8"
    );
    await writeFile(notesPath, "Generated release notes", "utf8");

    execFileSync(
      "pnpm",
      ["tsx", BIN, "--metadata", metadataPath, "--notes", notesPath],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    const notes = await readFile(notesPath, "utf8");
    expect(notes).toContain("Generated release notes\n\n```dispatch-update\n");
    expect(notes).toContain(
      '"requiredChecks": [\n    "service_restarted"\n  ]'
    );
  });

  it("fails with a useful parse error for malformed json", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dispatch-assisted-"));
    tmpDirs.push(dir);
    const metadataPath = path.join(dir, "meta.json");
    await writeFile(
      metadataPath,
      '{\n  "mode": "required",\n  "title": "Migration",\n  "summary":\n}\n',
      "utf8"
    );

    expect(() =>
      execFileSync(
        "pnpm",
        ["tsx", BIN, "--check-only", "--metadata", metadataPath],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        }
      )
    ).toThrowError(/line .* column|column .* line|metadata JSON parse error/);
  });
});
