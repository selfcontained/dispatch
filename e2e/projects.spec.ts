import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const headers = {
  Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
};
let repo: string;
test.beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "dispatch-projects-"));
  execFileSync("git", ["init", repo]);
});
test.afterAll(() => rmSync(repo, { recursive: true, force: true }));
test("explicit membership survives template moves and project deletion clears membership only", async ({
  request,
}) => {
  const make = await request.post("/api/v1/projects", {
    headers,
    data: { name: "Project API", repoRoot: repo, color: "#9575ed" },
  });
  expect(make.ok(), await make.text()).toBeTruthy();
  const project = await make.json();
  mkdirSync(join(repo, ".dispatch"));
  const logo =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="green"/></svg>';
  writeFileSync(join(repo, ".dispatch/logo.svg"), logo);
  const icon = await request.get(`/api/v1/projects/${project.id}/icon`, {
    headers,
  });
  expect(icon.ok()).toBeTruthy();
  expect(icon.headers()["content-security-policy"]).toBe(
    "default-src 'none'; style-src 'unsafe-inline'"
  );
  expect(icon.headers()["x-content-type-options"]).toBe("nosniff");
  expect(await icon.text()).toBe(logo);
  rmSync(join(repo, ".dispatch/logo.svg"));
  const rememberedIcon = await request.get(
    `/api/v1/projects/${project.id}/icon`,
    { headers }
  );
  expect(rememberedIcon.ok()).toBeTruthy();
  expect(rememberedIcon.headers()["content-security-policy"]).toBe(
    "default-src 'none'; style-src 'unsafe-inline'"
  );
  expect(rememberedIcon.headers()["x-content-type-options"]).toBe("nosniff");
  expect(await rememberedIcon.text()).toBe(logo);
  const duplicate = await request.post("/api/v1/projects", {
    headers,
    data: { name: "Duplicate", repoRoot: repo, color: "#9575ed" },
  });
  expect(duplicate.status()).toBe(409);
  const mixed = await request.post("/api/v1/agents", {
    headers,
    data: { type: "codex", projectId: project.id, cwd: repo },
  });
  expect(mixed.status()).toBe(400);
  const folder = await request.post("/api/v1/agents", {
    headers,
    data: { type: "codex", cwd: repo, name: "unassigned" },
  });
  expect(folder.ok(), await folder.text()).toBeTruthy();
  expect((await folder.json()).agent.projectId).toBeNull();
  const launch = await request.post("/api/v1/agents", {
    headers,
    data: { type: "codex", projectId: project.id, name: "assigned" },
  });
  expect(launch.ok(), await launch.text()).toBeTruthy();
  const agent = (await launch.json()).agent;
  expect(agent.projectId).toBe(project.id);
  const childResponse = await request.post("/api/v1/agents", {
    headers,
    data: { type: "codex", cwd: repo, parentAgentId: agent.id, name: "child" },
  });
  expect(childResponse.ok(), await childResponse.text()).toBeTruthy();
  expect((await childResponse.json()).agent.projectId).toBe(project.id);

  const templateResponse = await request.post("/api/v1/templates", {
    headers,
    data: {
      name: "Project template",
      directory: repo,
      projectId: project.id,
      agentType: "codex",
      prompt: "Summarize the repository.",
    },
  });
  expect(templateResponse.ok(), await templateResponse.text()).toBeTruthy();
  const template = await templateResponse.json();
  const templated = await request.post(
    `/api/v1/templates/${template.id}/launch`,
    { headers, data: {} }
  );
  expect(templated.ok(), await templated.text()).toBeTruthy();
  expect((await templated.json()).agent.projectId).toBe(project.id);
  const jobResponse = await request.post("/api/v1/jobs", {
    headers,
    data: {
      name: "Project job",
      directory: repo,
      projectId: project.id,
      prompt: "Summarize the repository.",
      agentType: "codex",
    },
  });
  expect(jobResponse.ok(), await jobResponse.text()).toBeTruthy();
  const job = await jobResponse.json();
  const jobs = await (await request.get("/api/v1/jobs", { headers })).json();
  expect(jobs.find((j: { id: string }) => j.id === job.id).projectId).toBe(
    project.id
  );
  const runResponse = await request.post("/api/v1/jobs/run", {
    headers,
    data: { name: job.name, directory: job.directory, wait: false },
  });
  expect(runResponse.ok(), await runResponse.text()).toBeTruthy();
  const run = await runResponse.json();
  const runningAgents = await (
    await request.get("/api/v1/agents", { headers })
  ).json();
  expect(
    runningAgents.agents.find((a: { id: string }) => a.id === run.agentId)
      .projectId
  ).toBe(project.id);
  await request.patch(`/api/v1/templates/${template.id}`, {
    headers,
    data: { projectId: null },
  });
  const agents = await (
    await request.get("/api/v1/agents", { headers })
  ).json();
  expect(
    agents.agents.find((a: { id: string }) => a.id === agent.id).projectId
  ).toBe(project.id);
  expect(
    (await request.delete(`/api/v1/projects/${project.id}`, { headers })).ok()
  ).toBeTruthy();
  const after = await (await request.get("/api/v1/agents", { headers })).json();
  expect(
    after.agents.find((a: { id: string }) => a.id === agent.id).projectId
  ).toBeNull();
  expect(
    (await request.get(`/api/v1/templates/${template.id}`, { headers })).ok()
  ).toBeTruthy();
  for (const a of after.agents.filter((a: { cwd: string }) => a.cwd === repo))
    await request.delete(`/api/v1/agents/${a.id}`, { headers });
});
