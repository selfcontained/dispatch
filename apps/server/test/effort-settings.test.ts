import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  getDefaultEffort,
  setDefaultEffort,
  resolveAgentEffort,
} from "../src/effort-settings.js";
import { validateAgentEffort } from "../src/shared/agent-effort.js";

function settings() {
  let value: string | null = null;
  const query = vi.fn(async (sql: string, args: unknown[]) => {
    if (sql.includes("INSERT")) value = args[1] as string;
    return { rows: value === null ? [] : [{ value }] };
  });
  return { pool: { query } as unknown as Pool, query };
}
describe("launch effort defaults", () => {
  it("preserves medium without a stored setting, persists null as CLI inheritance", async () => {
    const { pool } = settings();
    expect(await getDefaultEffort(pool)).toBe("medium");
    expect(await resolveAgentEffort(pool, "claude", undefined)).toBe("medium");
    await setDefaultEffort(pool, null);
    expect(await getDefaultEffort(pool)).toBeNull();
    expect(await resolveAgentEffort(pool, "claude", undefined)).toBeNull();
    await setDefaultEffort(pool, "high");
    expect(await resolveAgentEffort(pool, "claude", null)).toBe("high");
    expect(await resolveAgentEffort(pool, "claude", "xhigh")).toBe("xhigh");
  });
  it("does not break OpenCode with an inherited default but rejects explicit effort", async () => {
    const { pool } = settings();
    expect(await resolveAgentEffort(pool, "opencode", null)).toBeNull();
    await expect(
      resolveAgentEffort(pool, "opencode", "medium")
    ).rejects.toThrow("OpenCode");
  });
  it("rejects invalid levels without saving", async () => {
    const { pool, query } = settings();
    await expect(setDefaultEffort(pool, "turbo")).rejects.toThrow(
      "low, medium, high, xhigh, max"
    );
    await expect(setDefaultEffort(pool, undefined)).rejects.toThrow("required");
    expect(query).not.toHaveBeenCalled();
    expect(() => validateAgentEffort("codex", "max")).toThrow("Codex");
    expect(validateAgentEffort("codex", "xhigh")).toBe("xhigh");
  });
});
