import { expect, test, type Locator } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authHeaders,
  callMcpToolViaAPI,
  cleanupE2EAgents,
  createAgentViaAPI,
  seedBlockViaDB,
  trackAgent,
} from "./helpers";

const repo = mkdtempSync(join(tmpdir(), "dispatch-session-links-"));
test.afterAll(() => rmSync(repo, { recursive: true, force: true }));
function postedId(response: Record<string, unknown>): string {
  return JSON.parse(
    (response.result as { content: Array<{ text: string }> }).content[0]!.text
  ).id;
}
for (const width of [1280, 390]) {
  test(`passive task, stream, thread and Inbox identities open exact child sessions at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() =>
      localStorage.setItem("dispatch:chatShowChildAgents", "true")
    );
    const headers = authHeaders();
    const result = await request.post("/api/v1/projects", {
      headers,
      data: {
        name: `Session links ${width}`,
        repoRoot: repo,
        color: "#7c6ee6",
      },
    });
    expect(result.ok(), await result.text()).toBeTruthy();
    const project = await result.json();
    const rootResponse = await request.post("/api/v1/agents", {
      headers,
      data: {
        name: `Links root ${width}`,
        type: "codex",
        projectId: project.id,
        useWorktree: false,
      },
    });
    expect(rootResponse.ok(), await rootResponse.text()).toBeTruthy();
    const { agent: root } = await rootResponse.json();
    trackAgent(root.id);
    const child = await createAgentViaAPI(request, {
      name: `Links child ${width}`,
      cwd: repo,
      parentAgentId: root.id,
    });
    try {
      const taskResponse = await request.post("/api/v1/tasks", {
        headers,
        data: {
          projectId: project.id,
          title: `Identity task ${width}`,
          assignedAgentId: root.id,
        },
      });
      expect(taskResponse.ok(), await taskResponse.text()).toBeTruthy();
      const task = await taskResponse.json();
      const message = await seedBlockViaDB({
        streamId: task.id,
        authorKind: "agent",
        authorAgentId: child.id,
        toAgentId: root.id,
        text: "Actual child author to root recipient",
      });
      const taskUrl = `/tasks?project=${project.id}&task=${task.id}&pane=conversation`;
      await page.goto(taskUrl, { waitUntil: "domcontentloaded" });
      const conversation = page
        .getByTestId("task-conversation")
        .filter({ visible: true });
      await expect(conversation).toBeVisible();
      const post = conversation.locator(`[data-block-id="${message}"]`);
      await expect(post).toContainText("Actual child author");
      const visitAndBack = async (link: Locator, id: string) => {
        await expect(link).toHaveAttribute(
          "href",
          `/agents/${id}?project=${project.id}`
        );
        await link.click();
        await expect(page).toHaveURL(
          (url) =>
            url.pathname === `/agents/${id}` &&
            url.searchParams.get("project") === project.id &&
            [...url.searchParams.keys()].length === 1
        );
        await expect(
          page
            .getByTestId("chat-pane")
            .filter({ visible: true })
            .getByTestId("chat-composer-input")
        ).toBeEditable();
        await page.goBack();
      };
      await visitAndBack(
        post.getByTestId("chat-post-author").getByRole("link"),
        child.id
      );
      await expect(conversation).toBeVisible();
      await visitAndBack(
        post
          .locator("a")
          .filter({ has: page.getByTestId("chat-avatar-agent") }),
        child.id
      );
      await visitAndBack(
        post.getByTestId("chat-side-recipient").getByRole("link"),
        root.id
      );
      await expect(post).toBeVisible();
      const taskScreenshot = `/tmp/dispatch-session-links-task-${width}.png`;
      await page.screenshot({ path: taskScreenshot, fullPage: true });
      await test.info().attach(`Task names and icon ${width}`, {
        path: taskScreenshot,
        contentType: "image/png",
      });

      const streamPost = postedId(
        await callMcpToolViaAPI(request, child.id, "post", {
          text: "Child stream identity",
          placement: "home",
        })
      );
      await page.goto(`/agents/${root.id}?project=${project.id}`, {
        waitUntil: "domcontentloaded",
      });
      const feed = page.getByTestId("chat-pane").filter({ visible: true });
      const childPost = feed
        .locator(`[data-block-id="${streamPost}"]`)
        .filter({ visible: true });
      await expect(childPost).toContainText("Child stream identity");
      await visitAndBack(
        childPost.getByTestId("chat-post-author").getByRole("link"),
        child.id
      );
      await callMcpToolViaAPI(request, child.id, "post", {
        text: "Child reply identity",
        replyTo: streamPost,
      });
      await childPost.getByTestId("chat-reply-in-thread").click();
      const thread = page
        .getByTestId("chat-thread-panel")
        .filter({ visible: true });
      await expect(thread).toContainText("Child reply identity");
      const threadReply = thread
        .getByTestId("chat-message")
        .filter({ hasText: "Child reply identity" });
      await visitAndBack(
        threadReply.getByTestId("chat-post-author").getByRole("link"),
        child.id
      );
      await expect(thread).toBeVisible();
      const threadScreenshot = `/tmp/dispatch-session-links-thread-${width}.png`;
      await page.screenshot({ path: threadScreenshot, fullPage: true });
      await test.info().attach(`Visible child thread ${width}`, {
        path: threadScreenshot,
        contentType: "image/png",
      });

      const checklist = postedId(
        await callMcpToolViaAPI(request, child.id, "post", {
          text: "Child linked plan",
          tasks: { items: [{ id: "one", text: "Verify" }] },
          placement: "home",
        })
      );
      await page.goto(`/agents/${root.id}?project=${project.id}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(feed.getByTestId("chat-composer-input")).toBeEditable();
      // Closed drawers remain mounted: open via its toggle and assert in-viewport readiness.
      const toggle = page.getByTestId("toggle-drawer");
      if (await toggle.isVisible()) await toggle.click();
      const drawer = page.getByTestId("drawer");
      await expect(drawer.getByTestId("sidebar-tab-inbox")).toBeInViewport();
      await drawer.getByTestId("sidebar-tab-inbox").click();
      const card = drawer
        .getByTestId("inbox-checklist")
        .filter({ hasText: "Child linked plan" });
      const authorLink = card.getByRole("link", {
        name: `Open ${child.name} session`,
      });
      await expect(authorLink).toHaveAttribute(
        "href",
        `/agents/${child.id}?project=${project.id}`
      );
      await authorLink.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(
        (url) =>
          url.pathname === `/agents/${child.id}` &&
          url.searchParams.get("project") === project.id &&
          [...url.searchParams.keys()].length === 1
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(
        page
          .getByTestId("chat-pane")
          .filter({ visible: true })
          .getByTestId("chat-composer-input")
      ).toBeEditable();
      await page.goBack();
      await expect(card).toBeVisible();
      await card
        .getByRole("button", { name: /^Open Child linked plan/ })
        .click();
      await expect(page).toHaveURL(
        (url) => url.searchParams.get("thread") === checklist
      );
      await expect(
        page.getByTestId("chat-thread-panel").filter({ visible: true })
      ).toContainText("Child linked plan");
      const inboxScreenshot = `/tmp/dispatch-session-links-inbox-${width}.png`;
      await page.screenshot({ path: inboxScreenshot, fullPage: true });
      await test
        .info()
        .attach(`Inbox author and original-message controls ${width}`, {
          path: inboxScreenshot,
          contentType: "image/png",
        });
    } finally {
      await cleanupE2EAgents(request);
      await request.delete(`/api/v1/projects/${project.id}`, { headers });
    }
  });
}
