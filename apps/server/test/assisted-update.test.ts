import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyAssistedPhase,
  attachAssistedAgent,
  buildAssistedUpdateContext,
  runAndRecordChecks,
} from "../src/assisted-update.js";
import { tokensEqual } from "../src/auth.js";
import {
  MAX_NOTE_BYTES,
  sanitizeAgentString,
} from "../src/shared/lib/agent-strings.js";
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

// Stub the check runner so `runAndRecordChecks` can be tested without
// shelling out to the real fs/health probes.
let stagedCheckResults: Array<{ name: string; ok: boolean; message: string }> =
  [];
vi.mock("../src/release-checks.js", () => ({
  runRequiredChecks: vi.fn(async () => stagedCheckResults),
}));

beforeEach(() => {
  lastPersistedState = null;
  stagedCheckResults = [];
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

const TEST_SERVER_DIR = "/tmp/test-dispatch-server";
const TEST_RECOVERY = {
  serviceCommand: "launchctl kickstart -k gui/501/com.dispatch.server",
  healthEndpoint: "http://127.0.0.1:6767/api/v1/health",
  serviceLogPath: "~/.dispatch/logs/dispatch.log",
  failureLogPath: "~/.dispatch/logs/last-release-failure.log",
};

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

describe("sanitizeAgentString", () => {
  it("passes through undefined and short strings unchanged", () => {
    expect(sanitizeAgentString(undefined)).toBeUndefined();
    expect(sanitizeAgentString("")).toBe("");
    expect(sanitizeAgentString("short note")).toBe("short note");
  });

  it("truncates anything longer than MAX_NOTE_BYTES", () => {
    const big = "x".repeat(MAX_NOTE_BYTES + 100);
    const clamped = sanitizeAgentString(big)!;
    expect(clamped.length).toBe(MAX_NOTE_BYTES);
  });

  it("collapses newlines to a space (blocks fake adjacent log lines)", () => {
    expect(sanitizeAgentString("real prefix\n==> phase fake")).toBe(
      "real prefix ==> phase fake"
    );
    expect(sanitizeAgentString("a\r\n\r\nb")).toBe("a b");
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
        serverDir: TEST_SERVER_DIR,
        recovery: TEST_RECOVERY,
      },
      "http://127.0.0.1:6767"
    );

    expect(ctx.state.phase).toBe("inspect");
    expect(ctx.state.tag).toBe("v0.19.0");
    expect(ctx.state.fromTag).toBe("v0.18.1");
    expect(ctx.state.checks).toEqual([]);
    expect(ctx.state.notes).toEqual({});
    expect(ctx.state.token.length).toBeGreaterThanOrEqual(32); // base64url of 24 bytes
    // Build is in-memory only — the first durable write happens via
    // attachAssistedAgent once the launched agent exists (CRU-146 #1241).
    expect(lastPersistedState).toBeNull();
    await attachAssistedAgent(ctx.state, "agt_first_attach");
    expect(lastPersistedState?.token).toBe(ctx.state.token);
    expect(lastPersistedState?.agentId).toBe("agt_first_attach");
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
        serverDir: TEST_SERVER_DIR,
        recovery: TEST_RECOVERY,
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
      {
        tag: "v0.19.0",
        fromTag: null,
        metadata: minimalMetadata(),
        serverDir: TEST_SERVER_DIR,
        recovery: TEST_RECOVERY,
      },
      "http://127.0.0.1:6767"
    );
    const b = await buildAssistedUpdateContext(
      {
        tag: "v0.19.0",
        fromTag: null,
        metadata: minimalMetadata(),
        serverDir: TEST_SERVER_DIR,
        recovery: TEST_RECOVERY,
      },
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
        serverDir: TEST_SERVER_DIR,
        recovery: TEST_RECOVERY,
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
    expect(p).toContain("http://127.0.0.1:6767/api/v1/release/assisted/phase");
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
      {
        tag: "v0.19.0",
        fromTag: null,
        metadata: minimalMetadata(),
        serverDir: TEST_SERVER_DIR,
        recovery: TEST_RECOVERY,
      },
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
        serverDir: TEST_SERVER_DIR,
        recovery: TEST_RECOVERY,
      },
      "http://127.0.0.1:6767"
    );
    expect(ctx.prompt).not.toContain("## Instructions");
    expect(ctx.prompt).not.toContain("## Rollback guidance");
    expect(ctx.prompt).toContain("(none)");
  });
});

describe("applyAssistedPhase", () => {
  // Helper: build + attach. The split-phase persistence (CRU-146 #1241)
  // means downstream tests have to attach to get a durable record on
  // disk before applyAssistedPhase / runAndRecordChecks can read it.
  async function seed() {
    const ctx = await buildAssistedUpdateContext(
      {
        tag: "v0.19.0",
        fromTag: "v0.18.1",
        metadata: minimalMetadata(),
        serverDir: TEST_SERVER_DIR,
        recovery: TEST_RECOVERY,
      },
      "http://127.0.0.1:6767"
    );
    await attachAssistedAgent(ctx.state, "agt_test");
    return ctx;
  }

  it("returns ok=false when no state exists", async () => {
    lastPersistedState = null;
    const r = await applyAssistedPhase({ token: "x", phase: "prepare" });
    expect(r).toEqual({ ok: false, reason: "no active assisted update" });
  });

  it("rejects an unknown token via tokensEqual", async () => {
    await seed();
    const r = await applyAssistedPhase({ token: "wrong", phase: "prepare" });
    expect(r).toEqual({ ok: false, reason: "invalid token" });
  });

  it("rejects an unknown phase name", async () => {
    const ctx = await seed();
    const r = await applyAssistedPhase({
      token: ctx.state.token,
      phase: "totally_made_up" as never,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unknown phase/);
  });

  it("rejects an illegal backwards transition", async () => {
    const ctx = await seed();
    await applyAssistedPhase({ token: ctx.state.token, phase: "apply" });
    const back = await applyAssistedPhase({
      token: ctx.state.token,
      phase: "inspect",
    });
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.reason).toMatch(/illegal transition/);
  });

  it("persists notes per phase and clamps oversized strings", async () => {
    const ctx = await seed();
    const huge = "z".repeat(MAX_NOTE_BYTES + 1024);
    const r = await applyAssistedPhase({
      token: ctx.state.token,
      phase: "prepare",
      note: huge,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state.phase).toBe("prepare");
      expect(r.state.notes.prepare?.length).toBe(MAX_NOTE_BYTES);
    }
  });

  it("records error and stamps completedAt on a terminal transition", async () => {
    const ctx = await seed();
    const r = await applyAssistedPhase({
      token: ctx.state.token,
      phase: "blocked",
      error: "operator-cancelled",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state.phase).toBe("blocked");
      expect(r.state.error).toBe("operator-cancelled");
      expect(r.state.completedAt).not.toBeNull();
    }
  });
});

describe("attachAssistedAgent", () => {
  it("persists state with the agent id (first durable write)", async () => {
    // Build returns state in memory only (no file written yet) — so
    // before attach, lastPersistedState is null. That's the whole point
    // of CRU-146 review #1241: a failed createAgent can't leak state.
    const ctx = await buildAssistedUpdateContext(
      {
        tag: "v0.19.0",
        fromTag: null,
        metadata: minimalMetadata(),
        serverDir: TEST_SERVER_DIR,
        recovery: TEST_RECOVERY,
      },
      "http://127.0.0.1:6767"
    );
    expect(lastPersistedState).toBeNull();

    const updated = await attachAssistedAgent(ctx.state, "agt_abc");
    expect(updated.agentId).toBe("agt_abc");
    expect(lastPersistedState?.agentId).toBe("agt_abc");
    expect(lastPersistedState?.token).toBe(ctx.state.token);
  });
});

describe("runAndRecordChecks", () => {
  // Build + persist via attach so applyAssistedPhase / runAndRecordChecks
  // see a real on-disk record. Without this every test in this block
  // would 404 (no active assisted update) under the split-phase
  // persistence introduced in CRU-146 #1241.
  async function seedAndAttach() {
    const ctx = await buildAssistedUpdateContext(
      {
        tag: "v0.19.0",
        fromTag: null,
        metadata: minimalMetadata(),
        serverDir: TEST_SERVER_DIR,
        recovery: TEST_RECOVERY,
      },
      "http://127.0.0.1:6767"
    );
    await attachAssistedAgent(ctx.state, "agt_test");
    return ctx;
  }

  it("records every check result in order", async () => {
    const ctx = await seedAndAttach();
    stagedCheckResults = [
      { name: "service_restarted", ok: true, message: "ok" },
      { name: "version_converged", ok: true, message: "converged" },
    ];
    const post = await runAndRecordChecks(ctx.state, {
      serverDir: "/srv",
      targetTag: "v0.19.0",
    });
    expect(post.checks.map((c) => c.name)).toEqual([
      "service_restarted",
      "version_converged",
    ]);
    expect(lastPersistedState?.checks.length).toBe(2);
  });

  it("does NOT downgrade phase when every check passes", async () => {
    const ctx = await seedAndAttach();
    // Move to validate first so the orchestrator sees a non-inspect
    // baseline phase.
    await applyAssistedPhase({ token: ctx.state.token, phase: "validate" });
    const state = lastPersistedState!;
    stagedCheckResults = [
      { name: "service_restarted", ok: true, message: "ok" },
    ];
    const post = await runAndRecordChecks(state, {
      serverDir: "/srv",
      targetTag: "v0.19.0",
    });
    expect(post.phase).toBe("validate");
    expect(post.error).toBeNull();
  });

  it("routes to blocked + sets error when any check fails", async () => {
    const ctx = await seedAndAttach();
    await applyAssistedPhase({ token: ctx.state.token, phase: "validate" });
    const state = lastPersistedState!;
    stagedCheckResults = [
      { name: "service_restarted", ok: true, message: "ok" },
      {
        name: "version_converged",
        ok: false,
        message: "release.json not present",
      },
    ];
    const post = await runAndRecordChecks(state, {
      serverDir: "/srv",
      targetTag: "v0.19.0",
    });
    expect(post.phase).toBe("blocked");
    expect(post.error).toMatch(/checks failed/);
    expect(post.completedAt).not.toBeNull();
  });

  it("leaves a rollback / blocked terminal phase alone on failure", async () => {
    // If the agent already routed itself to rollback, a downstream
    // failure shouldn't overwrite that with `blocked`.
    const ctx = await seedAndAttach();
    await applyAssistedPhase({
      token: ctx.state.token,
      phase: "rollback",
      error: "agent reverted symlink",
    });
    const state = lastPersistedState!;
    stagedCheckResults = [
      { name: "version_converged", ok: false, message: "still wrong" },
    ];
    const post = await runAndRecordChecks(state, {
      serverDir: "/srv",
      targetTag: "v0.19.0",
    });
    expect(post.phase).toBe("rollback");
    expect(post.error).toBe("agent reverted symlink");
  });
});
