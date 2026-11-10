import { expect, test } from "@playwright/test";
import { seedBlockViaDB, cleanupE2EAgents, createAgentViaAPI } from "./helpers";

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
        // A later gesture still opens the same thread normally.
        await message(roots[0]!).click({ position: { x: 12, y: 12 } });
        await expect(page).toHaveURL(new RegExp(`thread=${roots[0]}`));
      }
      // A different message still intentionally switches threads.
      await message(roots[1]!).click({ position: { x: 12, y: 12 } });
      await expect(page).toHaveURL(new RegExp(`thread=${roots[1]}`));
      await page.getByTestId("drawer-close").click();
      await expect(page).not.toHaveURL(/thread=/);
      expect(await sidebarState()).toBe(false);
      // Explicit sidebar opening is intentional and replaces the thread.
      await message(roots[0]!).click({ position: { x: 12, y: 12 } });
      // Floating drawers cover the header toggle; pinned drawers leave it reachable.
      if (!pinned) await page.getByTestId("drawer-close").click();
      await page.getByTestId("toggle-drawer").click();
      await expect(page).not.toHaveURL(/thread=/);
      await expect.poll(sidebarState).toBe(true);
      await expect(page.getByTestId("thread-drawer")).toHaveCount(0);
      // Opening another thread takes the sidebar down; Escape keeps it down.
      await message(roots[0]!).click({ position: { x: 12, y: 12 } });
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
