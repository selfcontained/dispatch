import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { authHeaders, deleteAgentViaAPI } from "../helpers";
import {
  enrollViaUi,
  guest,
  guestOk,
  repositoryProject,
  state,
} from "./harness";

// This is a diagnostic, not an expected-failure regression. Record both results
// so a missing CLI cannot be hidden by the normal lane's fake gh installation.
test("managed public and private HTTPS checkouts without gh", async ({
  page,
  request,
}, testInfo) => {
  const container = state.runners.scratch.container;
  const publicProject = await repositoryProject(request, "scratch");
  const repository = guest(
    "scratch",
    "ls /tmp/runner-repositories/repos"
  ).trim();
  const publicUrl = `https://repo.runner.test:8443/${repository.replace(/\.git$/, "")}`;
  for (const [source, target] of [
    ["fixture-gh.sh", "fixture-gh"],
    ["github-fixture.sh", "github-fixture.sh"],
    ["github-fixture-server.cjs", "github-server.cjs"],
  ])
    execFileSync("docker", [
      "cp",
      resolve("e2e/remote-runner", source!),
      `${container}:/tmp/${target}`,
    ]);
  guest(
    "scratch",
    "sh /tmp/github-fixture.sh scratch; rm /usr/bin/gh /tmp/fixture-gh"
  );
  execFileSync("docker", [
    "exec",
    "-d",
    container,
    "node",
    "/tmp/github-server.cjs",
  ]);
  expect(guestOk("scratch", "command -v gh >/dev/null")).toBe(false);
  const runner = await enrollViaUi(page, request, "scratch");
  const privateUrl = "https://github.com/fixture-scratch/private";
  const privateProject = await request.post("/api/v1/projects", {
    headers: authHeaders(),
    data: {
      name: "Private no-gh probe",
      repository: privateUrl,
      color: "#64748b",
    },
  });
  expect(privateProject.ok(), await privateProject.text()).toBe(true);
  const privateProjectId = (await privateProject.json()).id as string;
  const agents: string[] = [];
  const results: unknown[] = [];
  try {
    const launch = async (kind: string, projectId: string) => {
      const response = await request.post("/api/v1/agents", {
        headers: authHeaders(),
        data: {
          name: `No gh ${kind}`,
          type: "claude",
          cwd: "",
          runner,
          projectId,
          useWorktree: false,
        },
      });
      const body = await response.json();
      if (!body.agent) {
        results.push({ kind, httpStatus: response.status(), body });
        return;
      }
      agents.push(body.agent.id);
      let current = body.agent;
      await expect
        .poll(
          async () => {
            const reply = await request.get(`/api/v1/agents/${body.agent.id}`, {
              headers: authHeaders(),
            });
            current = (await reply.json()).agent;
            return current.status;
          },
          { timeout: 30_000 }
        )
        .toMatch(/^(running|error)$/);
      results.push({
        kind,
        httpStatus: response.status(),
        status: current.status,
        lastError: current.lastError,
      });
    };
    await launch("public", publicProject);
    await launch("private", privateProjectId);
    // Compare ordinary Git with the helper environment the managed path injects.
    for (const [kind, url] of [
      ["public", publicUrl],
      ["private", privateUrl],
    ] as const) {
      const script = `setpriv --reuid 1500 --regid 1500 --clear-groups env HOME=/home/guest GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c 'credential.https://github.com.helper=!/usr/bin/gh auth git-credential' ls-remote '${url}' HEAD`;
      try {
        results.push({ kind, directGit: guest("scratch", script) });
      } catch (error) {
        results.push({
          kind,
          directGitError: String(error),
          stderr: String((error as { stderr?: unknown }).stderr ?? ""),
        });
      }
    }
    // A private origin needs credentials, but those need not come from gh.
    execFileSync("docker", [
      "exec",
      "-u",
      "1500:1500",
      container,
      "env",
      "HOME=/home/guest",
      "git",
      "config",
      "--global",
      "credential.https://github.com.helper",
      "!printf 'username=fixture-scratch\\npassword=test-only-scratch\\n'",
    ]);
    await launch("private-with-own-git-helper", privateProjectId);
    console.log("NO_GH_PROBE", JSON.stringify(results));
    await testInfo.attach("no-gh-results", {
      body: JSON.stringify(results, null, 2),
      contentType: "application/json",
    });
    expect(results).toContainEqual(
      expect.objectContaining({ kind: "public", status: "running" })
    );
    expect(results).toContainEqual(
      expect.objectContaining({
        kind: "private-with-own-git-helper",
        status: "running",
      })
    );
    expect(guestOk("scratch", "command -v gh >/dev/null")).toBe(false);
    const screenshot = testInfo.outputPath("no-gh-runner.png");
    await page.screenshot({ path: screenshot });
    await testInfo.attach("Runner online without gh", {
      path: screenshot,
      contentType: "image/png",
    });
  } finally {
    for (const id of agents) await deleteAgentViaAPI(request, id);
    for (const id of [publicProject, privateProjectId])
      await request.delete(`/api/v1/projects/${id}`, {
        headers: authHeaders(),
      });
  }
});
