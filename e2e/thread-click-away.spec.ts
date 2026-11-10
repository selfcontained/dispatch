import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import {
  authHeaders,
  seedBlockViaDB,
  cleanupE2EAgents,
  createAgentViaAPI,
} from "./helpers";

test.use({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
test.afterEach(async ({ request }) => cleanupE2EAgents(request));

for (const pinned of [false, true]) {
  for (const initiallyOpen of [false, true]) {
    test(`message click dismisses without reopening: pinned=${pinned}, sidebar=${initiallyOpen}`, async ({
      page,
      request,
    }, testInfo) => {
      const agent = await createAgentViaAPI(request);
      const roots = [];
      for (const text of [
        "First dismissal message",
        "Second dismissal message",
      ]) {
        roots.push(
          await seedBlockViaDB({ streamId: agent.id, authorKind: "user", text })
        );
      }
      await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
      const key = `dispatch:drawerState:${agent.id}`;
      await page.evaluate(
        ({ key, pinned, initiallyOpen }) => {
          localStorage.setItem(
            key,
            JSON.stringify({
              isOpen: initiallyOpen,
              isPinned: pinned,
              activeTab: "inbox",
            })
          );
        },
        { key, pinned, initiallyOpen }
      );
      await page.goto(`/agents/${agent.id}?thread=${roots[0]}`, {
        waitUntil: "domcontentloaded",
      });
      const message = (id: string) =>
        page
          .locator(
            `main [data-chat-entry-id="${id}"] [data-message-thread-tap]`
          )
          .first();
      const openViaMenu = async (id: string) => {
        await page
          .locator(`main [data-chat-entry-id="${id}"]`)
          .getByRole("button", { name: "Message actions", exact: true })
          .click();
        await page
          .getByRole("menuitem", { name: "Reply in thread", exact: true })
          .click();
        await expect(page.locator('[role="menu"]')).toHaveCount(0);
        await expect(page).toHaveURL(new RegExp(`thread=${id}`));
      };
      const sidebarState = () =>
        page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key)!).isOpen,
          key
        );
      for (let cycle = 0; cycle < 3; cycle++) {
        await expect(page.getByTestId("thread-drawer")).toBeVisible();
        // Real pointerdown clears the route before the message receives click.
        await message(roots[0]!).click({ position: { x: 12, y: 12 } });
        await expect(page).not.toHaveURL(/thread=/);
        await expect(page.getByTestId("thread-drawer")).toHaveCount(0);
        expect(await sidebarState()).toBe(false);
        // Body clicks remain inert on desktop; explicit actions still open threads.
        await message(roots[0]!).click({ position: { x: 12, y: 12 } });
        await expect(page).not.toHaveURL(/thread=/);
        await openViaMenu(roots[0]!);
      }
      // A different message can still be opened with an explicit action.
      if (!pinned) await page.getByTestId("drawer-close").click();
      await openViaMenu(roots[1]!);
      await expect(page).toHaveURL(new RegExp(`thread=${roots[1]}`));
      await page.getByTestId("drawer-close").click();
      await expect(page).not.toHaveURL(/thread=/);
      expect(await sidebarState()).toBe(false);
      // Explicit sidebar opening is intentional and replaces the thread.
      await openViaMenu(roots[0]!);
      // Floating drawers cover the header toggle; pinned drawers leave it reachable.
      if (!pinned) await page.getByTestId("drawer-close").click();
      await page.getByTestId("toggle-drawer").click();
      await expect(page).not.toHaveURL(/thread=/);
      await expect.poll(sidebarState).toBe(true);
      await expect(page.getByTestId("thread-drawer")).toHaveCount(0);
      // Deep-linking a thread takes the sidebar down; Escape keeps it down.
      await page.goto(`/agents/${agent.id}?thread=${roots[0]}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.getByTestId("thread-drawer")).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`thread=${roots[0]}`));
      await page
        .getByTestId("thread-drawer")
        .getByRole("button", { name: "Message actions", exact: true })
        .first()
        .click();
      await expect(page.getByRole("menu")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page).toHaveURL(new RegExp(`thread=${roots[0]}`));
      const composer = page
        .getByTestId("thread-drawer")
        .getByTestId("chat-composer-input");
      await expect(page.locator('[role="menu"]')).toHaveCount(0);
      await composer.fill("");
      await composer.pressSequentially(":smil");
      await expect(
        page.getByRole("listbox", { name: "Emoji shortcodes" })
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("listbox", { name: "Emoji shortcodes" })
      ).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`thread=${roots[0]}`));
      await page.keyboard.press("Escape");
      await expect(page).not.toHaveURL(/thread=/);
      await expect.poll(sidebarState).toBe(false);
      const path = testInfo.outputPath("dismissed.png");
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach("dismissed sidebar stays closed", {
        path,
        contentType: "image/png",
      });
    });
  }
}

test("task-board thread Escape returns to its conversation", async ({
  page,
  request,
}, testInfo) => {
  const repo = mkdtempSync(join(tmpdir(), "dispatch-thread-escape-"));
  execFileSync("git", ["init", repo]);
  const headers = authHeaders();
  let projectId: string | undefined;
  try {
    const response = await request.post("/api/v1/projects", {
      headers,
      data: { name: "Thread Escape", repoRoot: repo, color: "#7c6ee6" },
    });
    expect(response.ok(), await response.text()).toBe(true);
    projectId = (await response.json()).id;
    const created = await request.post("/api/v1/tasks", {
      headers,
      data: { projectId, title: "Task thread Escape" },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const task = await created.json();
    await seedBlockViaDB({
      streamId: task.id,
      authorKind: "user",
      toAgentId: null,
      text: "Task thread root",
    });
    await page.goto(`/tasks?project=${projectId}`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByTestId(`task-card-${task.id}`)
      .getByRole("button", { name: "Task thread Escape", exact: true })
      .click();
    await page.getByRole("tab", { name: "Conversation" }).click();
    const conversation = page.getByTestId("task-conversation");
    await conversation
      .getByRole("button", { name: "Message actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Reply in thread", exact: true })
      .click();
    await expect(conversation.getByTestId("chat-thread-panel")).toBeVisible();
    await expect(page.locator('[role="menu"]')).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(conversation.getByTestId("chat-thread-panel")).toHaveCount(0);
    await expect(
      conversation.getByTestId("task-conversation-scroll")
    ).toBeVisible();
    const path = testInfo.outputPath("task-thread-escape.png");
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach("Escape returns task thread to conversation", {
      path,
      contentType: "image/png",
    });
  } finally {
    if (projectId)
      await request.delete(`/api/v1/projects/${projectId}`, { headers });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("message-body opening is phone-only and follows viewport changes", async ({
  page,
  request,
}, testInfo) => {
  const agent = await createAgentViaAPI(request);
  const id = await seedBlockViaDB({
    streamId: agent.id,
    authorKind: "user",
    text: "Phone tap target",
  });
  for (const width of [390, 767, 768, 1024]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    const message = page.locator(
      `main [data-chat-entry-id="${id}"] [data-message-thread-tap]`
    );
    await message.click({ position: { x: 8, y: 8 } });
    if (width < 768) {
      await expect(page).toHaveURL(new RegExp(`thread=${id}`));
      await page
        .getByTestId("thread-drawer")
        .filter({ visible: true })
        .getByTestId("drawer-close")
        .click();
      await expect(page).not.toHaveURL(/thread=/);
      await expect(page.getByTestId("thread-drawer")).toHaveCount(0);
    } else {
      await expect(page).not.toHaveURL(/thread=/);
    }
    const path = testInfo.outputPath(`body-click-${width}.png`);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(`body-click at ${width}px`, {
      path,
      contentType: "image/png",
    });
  }
});
