import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authHeaders, trackAgent, loadApp, cleanupE2EAgents } from "./helpers";

const repo = mkdtempSync(join(tmpdir(), "dispatch-task-card-"));
test.afterAll(() => rmSync(repo, { recursive: true, force: true }));
for (const width of [1280, 390]) {
  test(`task card opens an overlay and returns focus at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const headers = authHeaders();
    const response = await request.post("/api/v1/projects", {
      headers,
      data: { name: `Task cards ${width}`, repoRoot: repo, color: "#7c6ee6" },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const project = await response.json();
    const agentResponse = await request.post("/api/v1/agents", {
      headers,
      data: {
        name: `Task card reader ${width}`,
        type: "codex",
        projectId: project.id,
        useWorktree: false,
      },
    });
    expect(agentResponse.ok(), await agentResponse.text()).toBeTruthy();
    const { agent } = await agentResponse.json();
    trackAgent(agent.id);
    try {
      const makeTask = async (title: string) => {
        const result = await request.post("/api/v1/tasks", {
          headers,
          data: { projectId: project.id, title },
        });
        expect(result.ok(), await result.text()).toBeTruthy();
        return result.json();
      };
      const task = await makeTask(`Shared task ${width}`);
      const second = await makeTask(`Related task ${width}`);
      // A task conversation can page the already-open modal via the same card.
      await request.patch(`/api/v1/tasks/${task.id}`, {
        headers,
        data: { assignedAgentId: agent.id },
      });
      const nested = await request.post(`/api/v1/streams/${task.id}/blocks`, {
        headers,
        data: { task: { id: second.id } },
      });
      expect(nested.ok(), await nested.text()).toBeTruthy();
      const post = await request.post(`/api/v1/streams/${agent.id}/blocks`, {
        headers,
        data: { task: { id: task.id } },
      });
      expect(post.ok(), await post.text()).toBeTruthy();
      expect((await post.json()).block.kind).toBe("task");
      await loadApp(page);
      await page.goto(`/agents/${agent.id}?project=${project.id}`, {
        waitUntil: "domcontentloaded",
      });
      const card = page
        .getByTestId("stream-task-card")
        .filter({ hasText: task.title });
      await expect(card).toBeVisible();
      const feed = page.getByTestId("chat-scroll");
      const scroll = (await feed.count())
        ? await feed.evaluate((el) => el.scrollTop)
        : null;
      await card.focus();
      await page.keyboard.press("Enter");
      const modal = page.getByTestId("task-modal");
      await expect(modal).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`task=${task.id}`));
      await expect(
        modal.getByRole("tab", { name: "Details", exact: true })
      ).toBeVisible();
      await expect(
        modal.getByRole("tab", { name: /^Conversation/ })
      ).toBeVisible();
      await page.screenshot({
        path: `/tmp/dispatch-task-card-${width}-modal.png`,
        scale: "device",
      });
      await modal
        .getByRole("button", { name: "Close task" })
        .filter({ visible: true })
        .first()
        .click();
      await expect(modal).toHaveCount(0);
      await expect(card).toBeFocused();
      if (scroll !== null)
        expect(await feed.evaluate((el) => el.scrollTop)).toBe(scroll);
      await page.screenshot({
        path: `/tmp/dispatch-task-card-${width}-closed.png`,
        scale: "device",
      });
      await card.click();
      await modal.getByRole("tab", { name: /^Conversation/ }).click();
      await modal
        .getByTestId("stream-task-card")
        .filter({ hasText: second.title })
        .click();
      await expect(page).toHaveURL(new RegExp(`task=${second.id}`));
      await expect(page.getByTestId("task-modal")).toHaveCount(1);
      await page.goBack();
      await expect(modal).toHaveCount(0);
      // Exercise the discoverable composer picker as well as the HTTP entry point.
      await page.getByRole("textbox", { name: "Message the agent" }).click();
      await page
        .getByRole("button", { name: "Share task", exact: true })
        .click();
      await page
        .getByPlaceholder("Search tasks or paste a task ID…")
        .fill(second.id);
      await page.getByRole("option", { name: second.title }).click();
      await expect(
        page.getByTestId("stream-task-card").filter({ hasText: second.title })
      ).toBeVisible();
    } finally {
      await cleanupE2EAgents(request);
      await request.delete(`/api/v1/projects/${project.id}`, { headers });
    }
  });
}
