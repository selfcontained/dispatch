import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { runnerDirectory } from "../src/runners/directory.js";
import { registerRunnerGitHub } from "../src/routes/runner-github.js";
import type { Runner } from "@dispatch/runner-protocol/contract";

it("lists Local's management capabilities without enrollment or connection state", async () => {
  const [local] = await runnerDirectory({}).managementList();
  expect(local).toMatchObject({
    id: "local",
    kind: "local",
    engineScope: { kind: "local" },
    githubManagement: true,
    engineManagement: true,
    repositoryPicker: true,
  });
  for (const key of [
    "status",
    "health",
    "automaticUpdates",
    "update",
    "enrollment",
    "connect",
    "revoke",
  ])
    expect(local).not.toHaveProperty(key);
});
it("routes all Local GitHub account actions through the directory's child", async () => {
  const call = vi.fn(async (..._args: unknown[]) => ({ status: "signed-out" }));
  const child = { call } as unknown as Runner;
  const directory = runnerDirectory({ child: () => child });
  const app = Fastify();
  registerRunnerGitHub(app, directory);
  try {
    for (const [method, path, operation] of [
      ["GET", "", "github.account"],
      ["POST", "/login", "github.login.start"],
      ["DELETE", "/login", "github.login.cancel"],
      ["DELETE", "", "github.logout"],
    ] as const) {
      const reply = await app.inject({
        method,
        url: "/api/v1/runners/local/github" + path,
      });
      expect(reply.statusCode).toBe(200);
      expect(reply.json()).toEqual({ status: "signed-out" });
      expect(call.mock.calls.at(-1)?.[0]).toBe(operation);
    }
  } finally {
    await app.close();
  }
});
