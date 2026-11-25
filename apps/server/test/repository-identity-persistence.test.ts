import { expect, it } from "vitest";
import { repositoryRecord } from "../src/runners/repository-identity.js";
import {
  controllerPlacement,
  placementForRunner,
} from "../src/runners/placement.js";

it("preserves main local repository object and serialized bytes", () => {
  const raw = {
    url: "https://EXAMPLE.com:443/org/../repo.git",
    checkout: { kind: "default" },
  };
  expect(repositoryRecord(controllerPlacement, raw)).toBe(raw);
  expect(JSON.stringify(repositoryRecord(controllerPlacement, raw))).toBe(
    JSON.stringify(raw)
  );
});
it.each([
  ["https://EXAMPLE.com:443/org/../repo.git", "https://example.com/repo"],
  ["https://example.com/%2e%2e/repo.git", "https://example.com/repo"],
  ["https://example.com/repo.git///", "https://example.com/repo"],
  ["https://example.com/.git", "https://example.com/"],
  ["git@example.com:org/repo.git", null],
])(
  "persists canonical identity without changing clone URL %s",
  (url, identityKey) => {
    expect(repositoryRecord(placementForRunner("fixture"), { url })).toEqual({
      url,
      identityKey,
    });
  }
);

it.each([
  ["local", undefined],
  ["fixture", "https://example.com/repo"],
])(
  "writes identity at the actual manager insert boundary for %s",
  async (runner, key) => {
    const { AgentManager } = await import("../src/agents/manager.js");
    const { vi } = await import("vitest");
    const query = vi.fn(async (_sql: string, _params: unknown[]) => ({
      rows: [],
    }));
    const manager = Object.assign(Object.create(AgentManager.prototype), {
      pool: { query },
    });
    const repository = {
      url: "https://EXAMPLE.com:443/org/../repo.git",
      checkout: { kind: "default" },
    };
    await manager.insertAgentRecord(
      { agentArgs: [], originalCwd: "/unchanged" },
      {},
      placementForRunner(runner),
      repository,
      null,
      false
    );
    const stored = JSON.parse(query.mock.calls[0]![1]![21] as string);
    expect(stored.url).toBe(repository.url);
    expect(stored.identityKey).toBe(key);
    if (runner === "local") expect(stored).toEqual(repository);
  }
);
