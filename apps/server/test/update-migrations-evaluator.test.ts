import { describe, expect, it } from "vitest";
import { evaluateFromManifests } from "../src/update-migrations-evaluator.js";

const MANIFEST = (id: string) => `
id: ${id}
title: ${id} title
summary: ${id} summary
alreadySatisfied:
  description: ok
instructions:
  - step
validation:
  requiredChecks: []
rollback: []
`;

describe("evaluateFromManifests", () => {
  it("returns ordered pending list filtered against applied ids", () => {
    const result = evaluateFromManifests(
      [
        { filename: "0002-second.yaml", contents: MANIFEST("second") },
        { filename: "0001-first.yaml", contents: MANIFEST("first") },
        { filename: "0003-third.yaml", contents: MANIFEST("third") },
      ],
      new Set(["second"])
    );
    expect(result.all.map((m) => m.manifest.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(result.pending.map((m) => m.manifest.id)).toEqual([
      "first",
      "third",
    ]);
    expect(result.errors).toEqual([]);
  });

  it("treats invalid manifests as errors but keeps valid ones", () => {
    const result = evaluateFromManifests(
      [
        { filename: "0001-first.yaml", contents: MANIFEST("first") },
        { filename: "0002-bad.yaml", contents: "not: [valid" },
      ],
      new Set()
    );
    expect(result.all.map((m) => m.manifest.id)).toEqual(["first"]);
    expect(result.errors.length).toBe(1);
  });

  it("ignores files that do not match the manifest filename pattern", () => {
    const result = evaluateFromManifests(
      [
        { filename: "0001-ok.yaml", contents: MANIFEST("ok") },
        { filename: "README.md", contents: "ignored" },
      ],
      new Set()
    );
    expect(result.all.map((m) => m.manifest.id)).toEqual(["ok"]);
  });

  it("flags duplicate ids as an error", () => {
    const result = evaluateFromManifests(
      [
        { filename: "0001-a.yaml", contents: MANIFEST("dup") },
        { filename: "0002-b.yaml", contents: MANIFEST("dup") },
      ],
      new Set()
    );
    expect(result.all.map((m) => m.manifest.id)).toEqual(["dup"]);
    expect(result.errors.length).toBe(1);
  });

  it("returns empty pending when every id is already applied", () => {
    const result = evaluateFromManifests(
      [
        { filename: "0001-a.yaml", contents: MANIFEST("a") },
        { filename: "0002-b.yaml", contents: MANIFEST("b") },
      ],
      new Set(["a", "b"])
    );
    expect(result.pending).toEqual([]);
  });
});
