import { expect, it, vi } from "vitest";
import {
  controllerPlacement,
  placementForRunner,
} from "../src/runners/placement.js";
import { agentTaskProject } from "../src/tasks/agent-scope.js";
const rootRead = vi.hoisted(() => vi.fn());
vi.mock("../src/shared/git/git-context.js", async (original) => ({
  ...(await original<typeof import("../src/shared/git/git-context.js")>()),
  resolveRepoRoot: rootRead,
}));
const agent = (cwd: string) => ({
  id: "scope-order",
  cwd,
  worktreePath: null,
  baseBranch: null,
  placement: controllerPlacement,
});
it("resolves local repository identity before project lookup and subsequent events", async () => {
  const order: string[] = [];
  let release!: (root: string) => void;
  const root = new Promise<string>((resolve) => {
    release = resolve;
  });
  rootRead.mockImplementation(() => {
    order.push("root:start");
    return root.then((value) => {
      order.push("root:end");
      return value;
    });
  });
  const scope = vi.fn(async () => {
    order.push("project");
    return "project";
  });
  const result = agentTaskProject(agent("/shared/repo/sub"), scope, () =>
    rootRead()
  ).then((project) => {
    order.push("event");
    return project;
  });
  expect(order).toEqual(["root:start"]);
  release("/shared/repo");
  expect(await result).toBe("project");
  expect(order).toEqual(["root:start", "root:end", "project", "event"]);
  expect(scope).toHaveBeenCalledExactlyOnceWith({
    projectId: null,
    paths: ["/shared/repo", "/shared/repo/sub"],
  });
});
it("does not turn a runner's same-spelled path into a controller folder key", async () => {
  rootRead.mockResolvedValue("/shared/repo");
  const scope = vi.fn(async () => null);
  const cwd = "runner://scope-runner/@session";
  await agentTaskProject(
    {
      ...agent(cwd),
      placement: placementForRunner("scope-runner"),
      workspacePath: "/shared/repo/sub",
    },
    scope,
    () => rootRead()
  );
  expect(scope).toHaveBeenCalledExactlyOnceWith({
    projectId: null,
    paths: [null, cwd],
  });
});
