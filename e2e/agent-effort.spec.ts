import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { authHeaders, loadApp, trackAgent, cleanupE2EAgents } from "./helpers";

const repo = mkdtempSync(join(tmpdir(), "dispatch-effort-"));
execFileSync("git", ["init", repo]);
test.afterAll(() => rmSync(repo, { recursive: true, force: true }));

test("template and trigger effort selectors persist overrides and inheritance", async ({
  page,
  request,
}, testInfo) => {
  const headers = authHeaders();
  const projectResponse = await request.post("/api/v1/projects", {
    headers,
    data: { name: "Effort controls", repoRoot: repo, color: "#7c6ee6" },
  });
  expect(projectResponse.ok(), await projectResponse.text()).toBeTruthy();
  const project = await projectResponse.json();
  let templateId: string | undefined;
  try {
    const templateResponse = await request.post("/api/v1/templates", {
      headers,
      data: {
        name: "Effort builder",
        directory: repo,
        projectId: project.id,
        agentType: "claude",
        effort: "high",
      },
    });
    expect(templateResponse.ok(), await templateResponse.text()).toBeTruthy();
    const template = await templateResponse.json();
    templateId = template.id;
    await loadApp(page);
    await page.goto(`/automations/templates/${template.id}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByTestId("template-config-effort")).toContainText(
      "high"
    );
    await page.getByTestId("template-config-effort").click();
    await page.getByRole("option", { name: "xhigh", exact: true }).click();
    const saved = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/templates/${template.id}`) &&
        r.request().method() === "PATCH"
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect((await saved).ok()).toBeTruthy();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("template-config-effort")).toContainText(
      "xhigh"
    );
    const templateScreenshot = testInfo.outputPath("template-effort.png");
    await page.screenshot({ path: templateScreenshot, fullPage: true });
    await testInfo.attach("template-effort", {
      path: templateScreenshot,
      contentType: "image/png",
    });
    const stored = await (
      await request.get(`/api/v1/templates/${template.id}`, { headers })
    ).json();
    expect(stored.effort).toBe("xhigh");
    const board = await (
      await request.get(`/api/v1/projects/${project.id}/tasks/board`, {
        headers,
      })
    ).json();
    const ready = board.columns.find(
      (column: { key: string }) => column.key === "ready"
    );
    const configured = await request.patch(`/api/v1/task-columns/${ready.id}`, {
      headers,
      data: {
        trigger: {
          templateId: template.id,
          agentType: null,
          model: null,
          effort: null,
          assign: true,
          fireOnCreate: false,
        },
      },
    });
    expect(configured.ok(), await configured.text()).toBeTruthy();
    await page.goto(`/tasks?project=${project.id}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByTestId("task-column-trigger-ready").click();
    const dialog = page.getByRole("dialog", { name: /^Trigger ·/ });
    await dialog.getByTestId("task-trigger-effort").click();
    await page.getByRole("option", { name: "medium", exact: true }).click();
    const triggerScreenshot = testInfo.outputPath("trigger-effort.png");
    await page.screenshot({ path: triggerScreenshot, fullPage: true });
    await testInfo.attach("trigger-effort", {
      path: triggerScreenshot,
      contentType: "image/png",
    });
    const triggerSaved = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/task-columns/${ready.id}`) &&
        r.request().method() === "PATCH"
    );
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    expect((await triggerSaved).ok()).toBeTruthy();
    await page.getByTestId("task-column-trigger-ready").click();
    await expect(dialog.getByTestId("task-trigger-effort")).toContainText(
      "medium"
    );
    await dialog.getByTestId("task-trigger-effort").click();
    await page.getByRole("option", { name: "Inherit", exact: true }).click();
    const cleared = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/task-columns/${ready.id}`) &&
        r.request().method() === "PATCH"
    );
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    expect((await cleared).ok()).toBeTruthy();
    const updatedBoard = await (
      await request.get(`/api/v1/projects/${project.id}/tasks/board`, {
        headers,
      })
    ).json();
    expect(
      updatedBoard.columns.find(
        (column: { id: string }) => column.id === ready.id
      ).trigger.effort
    ).toBeNull();
  } finally {
    if (templateId)
      await request.delete(`/api/v1/templates/${templateId}`, { headers });
    await request.delete(`/api/v1/projects/${project.id}`, { headers });
  }
});

test("global effort default is resolved for new agents and can be cleared", async ({
  request,
}) => {
  const headers = authHeaders();
  const settingUrl = "/api/v1/app/settings/effort";
  const original = await (await request.get(settingUrl, { headers })).json();
  const launch = async (effort?: string) => {
    const response = await request.post("/api/v1/agents", {
      headers,
      data: {
        name: "Effort acceptance",
        type: "claude",
        cwd: "/tmp",
        useWorktree: false,
        effort,
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const { agent } = await response.json();
    trackAgent(agent.id);
    return agent;
  };
  try {
    expect(
      (
        await request.post(settingUrl, { headers, data: { effort: "medium" } })
      ).ok()
    ).toBeTruthy();
    expect((await launch()).effort).toBe("medium");
    expect((await launch("xhigh")).effort).toBe("xhigh");
    expect(
      (await request.post(settingUrl, { headers, data: { effort: null } })).ok()
    ).toBeTruthy();
    expect((await launch()).effort).toBeNull();
    expect(
      (
        await request.post(settingUrl, { headers, data: { effort: "turbo" } })
      ).status()
    ).toBe(400);
  } finally {
    await request.post(settingUrl, { headers, data: original });
    await cleanupE2EAgents(request);
  }
});
