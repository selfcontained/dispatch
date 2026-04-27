import { describe, expect, it } from "vitest";
import {
  appendAssistedUpdateMetadataBlock,
  canonicalizeAssistedUpdateMetadata,
  inspectAssistedUpdateMetadata,
  isAssistedUpdateRequired,
  normalizeRequiredChecks,
  parseAssistedUpdateMetadata,
  type AssistedUpdateMetadata,
  validateAssistedUpdateMetadataJson,
} from "../src/release-metadata.js";

const sampleBody = (block: string) => `Some prose at the top.

\`\`\`dispatch-update
${block}
\`\`\`

More prose below.`;

describe("parseAssistedUpdateMetadata", () => {
  it("returns null when the body is empty", () => {
    expect(parseAssistedUpdateMetadata(null)).toBeNull();
    expect(parseAssistedUpdateMetadata(undefined)).toBeNull();
    expect(parseAssistedUpdateMetadata("")).toBeNull();
  });

  it("returns null when the fence is not present", () => {
    const body = "Just normal release notes\n- bullet\n";
    expect(parseAssistedUpdateMetadata(body)).toBeNull();
  });

  it("returns null when the fence body is malformed JSON", () => {
    const body = sampleBody("{ not: valid json }");
    expect(parseAssistedUpdateMetadata(body)).toBeNull();
  });

  it("reports invalid metadata distinctly when the fence is malformed", () => {
    const body = sampleBody("{ not: valid json }");
    expect(inspectAssistedUpdateMetadata(body)).toMatchObject({
      state: "invalid",
    });
  });

  it("returns null when required fields are missing", () => {
    const body = sampleBody(JSON.stringify({ mode: "required" }));
    expect(parseAssistedUpdateMetadata(body)).toBeNull();
  });

  it("parses a minimal block", () => {
    const body = sampleBody(
      JSON.stringify({
        mode: "recommended",
        title: "Migration",
        summary: "Run a migration before restart.",
      })
    );
    const meta = parseAssistedUpdateMetadata(body);
    expect(meta).not.toBeNull();
    expect(meta?.mode).toBe("recommended");
    expect(meta?.title).toBe("Migration");
    expect(meta?.requiredChecks).toEqual([]);
  });

  it("parses a full block with all fields", () => {
    const body = sampleBody(
      JSON.stringify({
        mode: "required",
        title: "Bun runtime migration",
        summary: "Switches the runtime from Node to Bun.",
        instructions: "Stop the service, copy /opt, restart.",
        requiredChecks: [
          "service_restarted",
          { name: "version_converged", description: "Final tag must match" },
        ],
        rollbackGuidance: "Revert the symlink in /opt.",
        appliesFrom: "v0.18.0",
      })
    );
    const meta = parseAssistedUpdateMetadata(body);
    expect(meta).not.toBeNull();
    expect(meta?.mode).toBe("required");
    expect(meta?.appliesFrom).toBe("v0.18.0");
    expect(normalizeRequiredChecks(meta!)).toEqual([
      "service_restarted",
      "version_converged",
    ]);
  });

  it("rejects unknown check names", () => {
    const body = sampleBody(
      JSON.stringify({
        mode: "required",
        title: "x",
        summary: "y",
        requiredChecks: ["totally_made_up"],
      })
    );
    expect(parseAssistedUpdateMetadata(body)).toBeNull();
  });

  it("rejects non-semver appliesFrom", () => {
    const body = sampleBody(
      JSON.stringify({
        mode: "required",
        title: "x",
        summary: "y",
        appliesFrom: "next",
      })
    );
    expect(parseAssistedUpdateMetadata(body)).toBeNull();
  });

  it("defaults mode to normal when omitted", () => {
    const body = sampleBody(JSON.stringify({ title: "x", summary: "y" }));
    const meta = parseAssistedUpdateMetadata(body);
    expect(meta?.mode).toBe("normal");
  });
});

describe("isAssistedUpdateRequired", () => {
  const required = (
    overrides: Partial<AssistedUpdateMetadata> = {}
  ): AssistedUpdateMetadata => ({
    mode: "required",
    title: "x",
    summary: "y",
    requiredChecks: [],
    ...overrides,
  });

  it("returns false when there is no metadata", () => {
    expect(isAssistedUpdateRequired(null, "v0.18.0")).toBe(false);
  });

  it("returns false when mode is recommended", () => {
    expect(
      isAssistedUpdateRequired(required({ mode: "recommended" }), "v0.18.0")
    ).toBe(false);
  });

  it("returns true when required and no appliesFrom", () => {
    expect(isAssistedUpdateRequired(required(), "v0.18.0")).toBe(true);
    expect(isAssistedUpdateRequired(required(), null)).toBe(true);
  });

  it("returns true when current >= appliesFrom", () => {
    expect(
      isAssistedUpdateRequired(required({ appliesFrom: "v0.18.0" }), "v0.18.0")
    ).toBe(true);
    expect(
      isAssistedUpdateRequired(required({ appliesFrom: "v0.18.0" }), "v0.19.5")
    ).toBe(true);
  });

  it("returns false when current < appliesFrom", () => {
    expect(
      isAssistedUpdateRequired(required({ appliesFrom: "v0.18.0" }), "v0.17.5")
    ).toBe(false);
  });
});

describe("validateAssistedUpdateMetadataJson", () => {
  it("returns a schema error with a zod path", () => {
    const result = validateAssistedUpdateMetadataJson(
      JSON.stringify({
        mode: "required",
        title: "x",
        summary: "y",
        requiredChecks: ["not-a-real-check"],
      })
    );
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error).toContain(
      "metadata schema mismatch at requiredChecks.0"
    );
  });

  it("rejects prose fields containing triple backticks", () => {
    const result = validateAssistedUpdateMetadataJson(
      JSON.stringify({
        mode: "required",
        title: "x",
        summary: "contains ``` fence",
      })
    );
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error).toContain("summary");
  });

  it("rejects triple backticks inside required check descriptions", () => {
    const result = validateAssistedUpdateMetadataJson(
      JSON.stringify({
        mode: "required",
        title: "x",
        summary: "y",
        requiredChecks: [
          {
            name: "service_restarted",
            description: "contains ``` fence",
          },
        ],
      })
    );
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error).toContain(
      "requiredChecks.0.description"
    );
  });

  it("includes a line and column hint for malformed json", () => {
    const result = validateAssistedUpdateMetadataJson(`{
  "mode": "required",
  "title": "x",
  "summary":
}`);
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error).toContain("line");
    expect(result.success ? "" : result.error).toContain("column");
  });
});

describe("assisted-update metadata embedding", () => {
  const metadata: AssistedUpdateMetadata = {
    mode: "required",
    title: "Bun runtime migration",
    summary: "Switches the runtime from Node to Bun.",
    instructions: "1. Stop the service.",
    requiredChecks: ["service_restarted", "version_converged"],
    rollbackGuidance: "Restore the previous symlink.",
    appliesFrom: "v0.18.0",
  };

  it("canonicalizes keys in a stable order", () => {
    expect(canonicalizeAssistedUpdateMetadata(metadata)).toBe(`{
  "mode": "required",
  "title": "Bun runtime migration",
  "summary": "Switches the runtime from Node to Bun.",
  "instructions": "1. Stop the service.",
  "requiredChecks": [
    "service_restarted",
    "version_converged"
  ],
  "rollbackGuidance": "Restore the previous symlink.",
  "appliesFrom": "v0.18.0"
}`);
  });

  it("appends a fenced block to release notes", () => {
    const notes = appendAssistedUpdateMetadataBlock("Release prose", metadata);
    expect(notes).toContain("Release prose\n\n```dispatch-update\n");
    expect(notes).toContain('"mode": "required"');
    expect(notes.endsWith("```\n")).toBe(true);
  });
});
