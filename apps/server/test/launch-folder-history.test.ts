import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { registerActivityHistoryRoutes } from "../src/routes/activity/history-routes.js";
import { registerLaunchTargetRoutes } from "../src/routes/launch-targets.js";
import {
  controllerPlacement,
  placementForRunner,
} from "../src/runners/placement.js";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function setup(remote = false) {
  const app = Fastify();
  apps.push(app);
  const rows = [
    {
      project: "/var/unchanged",
      usage_count: 4,
      latest_created_at: new Date("2026-01-01"),
      agent_id: "controller",
    },
    ...(remote
      ? [
          {
            project: "/srv/fixture/checkout",
            usage_count: 2,
            latest_created_at: new Date("2026-01-01"),
            agent_id: "runner",
          },
        ]
      : []),
  ];
  const query = vi.fn(async (_sql: string, params: unknown[]) => ({
    rows: params.includes("local")
      ? rows.filter((row) => row.agent_id === "controller")
      : rows,
  }));
  await registerActivityHistoryRoutes(app, { pool: { query } } as never);
  app.get("/api/runners", async () => ({
    runners: [{ id: "fixture", name: "Fixture", status: "offline" }],
  }));
  await registerLaunchTargetRoutes(app, {
    agents: {
      getAgent: async (id: string) => ({
        placement:
          id === "controller"
            ? controllerPlacement
            : placementForRunner("fixture"),
      }),
    },
    runners: {
      managementList: async () => [
        { id: "local", name: "Local", kind: "local", repositoryPicker: true },
        { id: "fixture", name: "Fixture", status: "offline" },
      ],
    },
    templates: {},
    tasks: {},
  } as never);
  const targets = (await app.inject("/api/v1/launch-targets")).json().targets;
  return { app, targets, query };
}
it.each(["", "?limit=1", "?limit=50&search=unchanged"])(
  "pins main's controller history bytes and scopes query membership %s",
  async (suffix) => {
    const { app, targets, query } = await setup();
    query.mockClear();
    const main = await app.inject("/api/v1/history/projects" + suffix);
    const args = query.mock.calls[0];
    const projected = await app.inject(targets[0].historyUrl + suffix);
    expect(projected.body).toBe(main.body);
    expect(query.mock.calls[1]![1]).toEqual([
      ...args![1].slice(0, -1),
      "local",
      args![1].at(-1),
    ]);
  }
);
it("excludes runner agents without rejecting ordinary folder strings", async () => {
  const { app, targets } = await setup(true);
  const result = (
    await app.inject(
      targets[0].historyUrl +
        "?candidates=" +
        encodeURIComponent(JSON.stringify(["~/missing", "/var/raw"]))
    )
  ).json();
  expect(result.projects).toEqual(["/var/unchanged", "~/missing", "/var/raw"]);
  expect(result.projectOptions).toHaveLength(1);
  expect((await app.inject(targets[1].historyUrl)).json()).toEqual({
    projects: [],
    projectOptions: [],
  });
});
