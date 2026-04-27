import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  filterPending,
  loadUpdateMigrations,
  parseManifest,
} from "../src/update-migrations.js";

const VALID_MANIFEST = `
id: bun-cutover
title: Bun runtime cutover
summary: Move installs from the Node-era runtime to the Bun runtime.
alreadySatisfied:
  description: The service entrypoint already targets the Bun wrapper.
instructions:
  - Inspect the service entrypoint
  - Repoint to the Bun wrapper if needed
  - Restart the service
validation:
  requiredChecks:
    - expected_runtime_artifact
    - service_entrypoint
    - service_restarted
    - health_endpoint
    - version_converged
rollback:
  - Restore the prior entrypoint
  - Restart the service
`;

describe("parseManifest", () => {
  it("accepts a v1 manifest with all fields", () => {
    const result = parseManifest(VALID_MANIFEST);
    if (!result.success) throw new Error(result.error);
    expect(result.data.id).toBe("bun-cutover");
    expect(result.data.title).toBe("Bun runtime cutover");
    expect(result.data.instructions.length).toBe(3);
    expect(result.data.validation.requiredChecks).toEqual([
      "expected_runtime_artifact",
      "service_entrypoint",
      "service_restarted",
      "health_endpoint",
      "version_converged",
    ]);
    expect(result.data.rollback.length).toBe(2);
  });

  it("rejects an unknown requiredChecks entry", () => {
    const result = parseManifest(`
id: bad
title: t
summary: s
alreadySatisfied:
  description: d
instructions:
  - step
validation:
  requiredChecks:
    - made_up_check
rollback: []
`);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/requiredChecks/);
  });

  it("rejects missing alreadySatisfied.description", () => {
    const result = parseManifest(`
id: bad
title: t
summary: s
alreadySatisfied: {}
instructions:
  - step
validation:
  requiredChecks: []
rollback: []
`);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/alreadySatisfied/);
  });

  it("rejects an id with uppercase characters", () => {
    const result = parseManifest(`
id: BadId
title: t
summary: s
alreadySatisfied:
  description: d
instructions:
  - step
validation:
  requiredChecks: []
rollback: []
`);
    expect(result.success).toBe(false);
  });

  it("rejects malformed YAML with a parse error", () => {
    const result = parseManifest("id: [unterminated");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/YAML parse error/);
  });
});

describe("loadUpdateMigrations", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "dispatch-mig-loader-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns empty result for missing directory", async () => {
    const missing = path.join(dir, "does-not-exist");
    const result = await loadUpdateMigrations(missing);
    expect(result.migrations).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("orders manifests by numeric prefix", async () => {
    await writeFile(
      path.join(dir, "0010-second.yaml"),
      VALID_MANIFEST.replace("bun-cutover", "second")
    );
    await writeFile(
      path.join(dir, "0001-first.yaml"),
      VALID_MANIFEST.replace("bun-cutover", "first")
    );
    const result = await loadUpdateMigrations(dir);
    expect(result.migrations.map((m) => m.manifest.id)).toEqual([
      "first",
      "second",
    ]);
  });

  it("ignores files that don't match the prefix-id.yaml pattern", async () => {
    await writeFile(
      path.join(dir, "0001-ok.yaml"),
      VALID_MANIFEST.replace("bun-cutover", "ok")
    );
    await writeFile(path.join(dir, "README.md"), "ignored");
    await writeFile(path.join(dir, "foo.yaml"), "ignored");
    const result = await loadUpdateMigrations(dir);
    expect(result.migrations.map((m) => m.filename)).toEqual(["0001-ok.yaml"]);
  });

  it("reports duplicate ids as errors", async () => {
    await writeFile(
      path.join(dir, "0001-a.yaml"),
      VALID_MANIFEST.replace("bun-cutover", "shared-id")
    );
    await writeFile(
      path.join(dir, "0002-b.yaml"),
      VALID_MANIFEST.replace("bun-cutover", "shared-id")
    );
    const result = await loadUpdateMigrations(dir);
    expect(result.migrations.length).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.error).toMatch(/duplicate migration id/);
  });

  it("reports per-file parse errors without dropping other files", async () => {
    await writeFile(path.join(dir, "0001-bad.yaml"), "not: [valid yaml");
    await writeFile(
      path.join(dir, "0002-good.yaml"),
      VALID_MANIFEST.replace("bun-cutover", "good")
    );
    const result = await loadUpdateMigrations(dir);
    expect(result.migrations.map((m) => m.manifest.id)).toEqual(["good"]);
    expect(result.errors.map((e) => e.filename)).toEqual(["0001-bad.yaml"]);
  });
});

describe("filterPending", () => {
  it("removes already-applied ids while preserving order", () => {
    const migrations = [
      makeFile("0001-a.yaml", "a"),
      makeFile("0002-b.yaml", "b"),
      makeFile("0003-c.yaml", "c"),
    ];
    const pending = filterPending(migrations, new Set(["b"]));
    expect(pending.map((m) => m.manifest.id)).toEqual(["a", "c"]);
  });

  it("returns empty list when every id is applied", () => {
    const migrations = [
      makeFile("0001-a.yaml", "a"),
      makeFile("0002-b.yaml", "b"),
    ];
    expect(filterPending(migrations, new Set(["a", "b"]))).toEqual([]);
  });
});

function makeFile(filename: string, id: string) {
  return {
    filename,
    order: Number(filename.split("-")[0]),
    manifest: {
      id,
      title: id,
      summary: id,
      alreadySatisfied: { description: "x" },
      instructions: ["x"],
      validation: { requiredChecks: [] },
      rollback: [],
    },
  };
}
