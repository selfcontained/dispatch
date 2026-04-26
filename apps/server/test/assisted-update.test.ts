import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAssistedUpdateContext,
  clampNote,
  MAX_NOTE_BYTES,
  tokensEqual,
} from "../src/assisted-update.js";
import type { AssistedUpdateMetadata } from "../src/release-metadata.js";
import type { AssistedUpdateState } from "../src/assisted-update-store.js";

// Stub the on-disk write so `buildAssistedUpdateContext` doesn't touch
// the operator's real ~/.dispatch directory while running tests.
let lastPersistedState: AssistedUpdateState | null = null;
vi.mock("../src/assisted-update-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/assisted-update-store.js")>();
  return {
    ...actual,
    readAssistedUpdateState: vi.fn(async () => lastPersistedState),
    writeAssistedUpdateState: vi.fn(async (state: AssistedUpdateState) => {
      lastPersistedState = state;
    }),
    clearAssistedUpdateState: vi.fn(async () => {
      lastPersistedState = null;
    }),
  };
});

beforeEach(() => {
  lastPersistedState = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const minimalMetadata = (
  overrides: Partial<AssistedUpdateMetadata> = {}
): AssistedUpdateMetadata => ({
  mode: "required",
  title: "Bun runtime migration",
  summary: "Switches the runtime from Node to Bun.",
  instructions: "1. Stop the service.\n2. Swap the symlink.",
  rollbackGuidance: "Restore the previous symlink and `launchctl kickstart`.",
  requiredChecks: ["service_restarted", "version_converged"],
  ...overrides,
});

describe("tokensEqual", () => {
  it("returns true for byte-identical strings", () => {
    expect(tokensEqual("abc", "abc")).toBe(true);
  });

  it("returns false on a length mismatch (avoids timingSafeEqual throw)", () => {
    expect(tokensEqual("abc", "abcd")).toBe(false);
    expect(tokensEqual("", "x")).toBe(false);
  });

  it("returns false for differing strings of equal length", () => {
    expect(tokensEqual("abcdef", "abcdeg")).toBe(false);
  });

  it("handles unicode without crashing", () => {
    // Buffer.from(..., 'utf-8') byte-encodes; equal codepoints should
    // still compare equal.
    expect(tokensEqual("✓", "✓")).toBe(true);
    expect(tokensEqual("✓", "✗")).toBe(false);
  });
});

describe("clampNote", () => {
  it("passes through undefined and short strings unchanged", () => {
    expect(clampNote(undefined)).toBeUndefined();
    expect(clampNote("")).toBe("");
    expect(clampNote("short note")).toBe("short note");
  });

  it("truncates anything longer than MAX_NOTE_BYTES", () => {
    const big = "x".repeat(MAX_NOTE_BYTES + 100);
    const clamped = clampNote(big)!;
    expect(clamped.length).toBe(MAX_NOTE_BYTES);
  });

  it("MAX_NOTE_BYTES is 4 KiB", () => {
    expect(MAX_NOTE_BYTES).toBe(4096);
  });
});

describe("buildAssistedUpdateContext", () => {
  it("persists initial state with phase=inspect and a fresh token", async () => {
    const ctx = await buildAssistedUpdateContext(
      {
        tag: "v0.19.0",
        fromTag: "v0.18.1",
        metadata: minimalMetadata(),
      },
      "http://127.0.0.1:6767"
    );

    expect(ctx.state.phase).toBe("inspect");
    expect(ctx.state.tag).toBe("v0.19.0");
    expect(ctx.state.fromTag).toBe("v0.18.1");
    expect(ctx.state.checks).toEqual([]);
    expect(ctx.state.notes).toEqual({});
    expect(ctx.state.token.length).toBeGreaterThanOrEqual(32); // base64url of 24 bytes
    // The mock store should have captured the same record we got back.
    expect(lastPersistedState?.token).toBe(ctx.state.token);
  });

  it("normalizes the requiredChecks down to a flat string list", async () => {
    const ctx = await buildAssistedUpdateContext(
      {
        tag: "v0.19.0",
        fromTag: null,
        metadata: minimalMetadata({
          requiredChecks: [
            "service_restarted",
            { name: "version_converged", description: "must match" },
          ],
        }),
      },
      "http://127.0.0.1:6767"
    );
    expect(ctx.state.requiredChecks).toEqual([
      "service_restarted",
      "version_converged",
    ]);
  });

  it("rotates the nonce between launches", async () => {
    const a = await buildAssistedUpdateContext(
      { tag: "v0.19.0", fromTag: null, metadata: minimalMetadata() },
      "http://127.0.0.1:6767"
    );
    const b = await buildAssistedUpdateContext(
      { tag: "v0.19.0", fromTag: null, metadata: minimalMetadata() },
      "http://127.0.0.1:6767"
    );
    expect(a.state.token).not.toBe(b.state.token);
  });

  it("renders a prompt that contains every load-bearing detail", async () => {
    const ctx = await buildAssistedUpdateContext(
      {
        tag: "v0.19.0",
        fromTag: "v0.18.1",
        metadata: minimalMetadata({
          title: "Bun runtime migration",
          summary: "Switches the runtime from Node to Bun.",
          instructions: "Stop the service then swap the symlink.",
          rollbackGuidance: "Restore the previous symlink.",
          requiredChecks: ["service_restarted", "version_converged"],
        }),
      },
      "http://127.0.0.1:6767/"
    );

    const p = ctx.prompt;
    expect(p).toContain("Bun runtime migration");
    expect(p).toContain("Switches the runtime from Node to Bun.");
    expect(p).toContain("Stop the service then swap the symlink.");
    expect(p).toContain("Restore the previous symlink.");
    expect(p).toContain("service_restarted");
    expect(p).toContain("version_converged");
    // Strips the trailing slash on the supplied baseUrl.
    expect(p).toContain(
      "http://127.0.0.1:6767/api/v1/release/update/assisted/phase"
    );
    expect(p).toContain(`"token": "${ctx.state.token}"`);
    // Phase ordering must match what the runtime accepts.
    expect(p).toContain(
      "inspect → prepare → apply → restarting → validate → done"
    );
    // Includes context the agent uses to plan the work.
    expect(p).toContain("- target: v0.19.0");
    expect(p).toContain("- installed: v0.18.1");
    expect(p).toContain(`- mode: required`);
  });

  it("reports installed=(unknown) when fromTag is null", async () => {
    const ctx = await buildAssistedUpdateContext(
      { tag: "v0.19.0", fromTag: null, metadata: minimalMetadata() },
      "http://127.0.0.1:6767"
    );
    expect(ctx.prompt).toContain("- installed: (unknown)");
  });

  it("omits the optional sections when metadata fields are missing", async () => {
    const ctx = await buildAssistedUpdateContext(
      {
        tag: "v0.19.0",
        fromTag: null,
        metadata: minimalMetadata({
          instructions: undefined,
          rollbackGuidance: undefined,
          requiredChecks: [],
        }),
      },
      "http://127.0.0.1:6767"
    );
    expect(ctx.prompt).not.toContain("## Instructions");
    expect(ctx.prompt).not.toContain("## Rollback guidance");
    expect(ctx.prompt).toContain("(none)");
  });
});
