import { randomUUID } from "node:crypto";

import { expect, type Page, test } from "@playwright/test";
import { Pool } from "pg";

import {
  callMcpToolViaAPI,
  cleanupE2EAgents,
  createAgentViaAPI,
} from "./helpers";

/**
 * A long stream renders only the rows near the view (useWindowedRows):
 * spacers stand in for the rest, and the reader's place, the bottom, a
 * page of older rows and a jump to one block all behave as they do with
 * every row mounted.
 */

const ROWS = 240;

/** `count` agent posts, a minute apart and of varied height, oldest first. */
async function seedPosts(streamId: string, count: number): Promise<string[]> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  const pool = new Pool({ connectionString, max: 1 });
  const ids: string[] = [];
  const now = Date.now();
  try {
    for (let i = 0; i < count; i += 1) {
      const id = randomUUID();
      ids.push(id);
      const lines = 1 + (i % 7);
      const text = Array.from(
        { length: lines },
        (_, n) => `Post ${i} line ${n}: the review stream keeps its place.`
      ).join("\n\n");
      const at = new Date(now - (count - i) * 60_000).toISOString();
      await pool.query(
        `INSERT INTO blocks (id, stream_id, author_kind, author_agent_id, kind, text, created_at, updated_at)
         VALUES ($1, $2, 'agent', $2, 'text', $3, $4, $4)`,
        [id, streamId, text, at]
      );
    }
  } finally {
    await pool.end();
  }
  return ids;
}

function scroller(page: Page) {
  return page.getByTestId("chat-scroll");
}

/** The first row whose top is in view, and where it sits. */
async function topRow(
  page: Page
): Promise<{ id: string; offset: number } | null> {
  return scroller(page).evaluate((el) => {
    const { top, bottom } = el.getBoundingClientRect();
    const row = [
      ...el.querySelectorAll<HTMLElement>("[data-chat-entry-id]"),
    ].find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.top >= top && rect.top < bottom;
    });
    return row
      ? {
          id: row.dataset.chatEntryId!,
          offset: Math.round(row.getBoundingClientRect().top - top),
        }
      : null;
  });
}

/** The lowest row wholly in view, and where it sits. */
async function bottomRow(page: Page): Promise<{ id: string; offset: number }> {
  return scroller(page).evaluate((el) => {
    const { top, bottom } = el.getBoundingClientRect();
    const rows = [...el.querySelectorAll<HTMLElement>("[data-chat-entry-id]")];
    const row = rows.reverse().find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.top >= top && rect.bottom <= bottom;
    })!;
    return {
      id: row.dataset.chatEntryId!,
      offset: Math.round(row.getBoundingClientRect().top - top),
    };
  });
}

async function mountedRows(page: Page): Promise<number> {
  return page
    .getByTestId("chat-scroll")
    .locator("[data-chat-entry-id]")
    .count();
}

test.describe("Stream windowing", () => {
  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  for (const width of [1280, 390]) {
    test(`typing a multiline draft preserves the idle stream at width ${width}`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      const agent = await createAgentViaAPI(request);
      const ids = await seedPosts(agent.id, 20);
      await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
      await expect(
        page.locator(`[data-chat-entry-id="${ids[19]}"]`)
      ).toBeInViewport();
      const input = page.getByTestId("chat-composer-input");
      await input.fill("one\ntwo\nthree\nfour\nfive");
      const stream = scroller(page);
      for (const distance of [0, 65, 250]) {
        await stream.evaluate((el, gap) => {
          el.scrollTop = el.scrollHeight - el.clientHeight - gap;
        }, distance);
        await expect
          .poll(() =>
            stream.evaluate((el) =>
              Math.round(el.scrollHeight - el.clientHeight - el.scrollTop)
            )
          )
          .toBe(distance);
        // Let the scroll handler and windowed rows settle before typing.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve())
              );
            })
        );
        const before = await stream.evaluate((el) => el.scrollTop);
        const height = await input.evaluate((el) => el.clientHeight);
        await input.press("End");
        await input.pressSequentially(" typing", { delay: 30 });
        await input.press("Backspace");
        await expect
          .poll(() => stream.evaluate((el) => el.scrollTop))
          .toBe(before);
        expect(await input.evaluate((el) => el.clientHeight)).toBe(height);
      }
      const multilineHeight = await input.evaluate((el) => el.clientHeight);
      await input.fill("short");
      expect(await input.evaluate((el) => el.clientHeight)).toBeLessThan(
        multilineHeight
      );
      await input.fill(Array.from({ length: 30 }, () => "line").join("\n"));
      expect(await input.evaluate((el) => el.clientHeight)).toBeLessThanOrEqual(
        192
      );
      expect(await input.evaluate((el) => el.scrollHeight)).toBeGreaterThan(
        192
      );
    });
  }

  test("a long stream mounts a window of rows and keeps the reader's place", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-windowing-${Date.now()}`,
    });
    const ids = await seedPosts(agent.id, ROWS);

    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    const newest = page.locator(`[data-chat-entry-id="${ids[ROWS - 1]}"]`);
    await expect(newest).toBeInViewport();
    // The first page is 100 rows; only those near the bottom are mounted.
    await expect.poll(() => mountedRows(page)).toBeLessThan(60);
    await expect(page.getByTestId("window-gap").first()).toBeAttached();

    // Scrolling to the top of the page mounts the rows there: the oldest
    // of the first page (it also holds the agent's own launch post).
    await scroller(page).evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect
      .poll(async () => {
        const row = await topRow(page);
        const index = row ? ids.indexOf(row.id) : -1;
        return index >= ROWS - 100 && index < ROWS - 90;
      })
      .toBe(true);

    // A page of older rows lands above without moving what is in view. (The
    // first row may lose its header to an older post by the same author;
    // the rows under it stay put.)
    const before = await bottomRow(page);
    const heightBefore = await scroller(page).evaluate((el) => el.scrollHeight);
    await scroller(page).getByRole("button", { name: "Load older" }).click();
    // The page is in: a hundred more rows' worth of spacer above.
    await expect
      .poll(() => scroller(page).evaluate((el) => el.scrollHeight))
      .toBeGreaterThan(heightBefore + 3000);
    // Once the rows around it have measured themselves, the row is where
    // it was.
    await page.waitForTimeout(500);
    const offsetAfter = await scroller(page).evaluate(
      (el, id) =>
        el
          .querySelector(`[data-chat-entry-id="${id}"]`)!
          .getBoundingClientRect().top - el.getBoundingClientRect().top,
      before.id
    );
    expect(Math.abs(offsetAfter - before.offset)).toBeLessThanOrEqual(1);
    await expect.poll(() => mountedRows(page)).toBeLessThan(80);

    // A jump to a row that is not mounted brings it into view and marks it.
    const target = ids[ROWS - 60]!;
    await expect(page.locator(`[data-chat-entry-id="${target}"]`)).toHaveCount(
      0
    );
    await page.goto(`/agents/${agent.id}?block=${target}`, {
      waitUntil: "domcontentloaded",
    });
    const jumped = page.locator(`[data-chat-entry-id="${target}"]`);
    await expect(jumped).toBeInViewport();
    await expect(jumped).toHaveAttribute("data-jump-flash", "");

    // Back at the bottom, a new post is followed into view.
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await expect(jumped).toBeAttached();
    await scroller(page).evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(newest).toBeInViewport();
    await callMcpToolViaAPI(request, agent.id, "post", {
      text: "A new post at the bottom.",
    });
    await expect(page.getByText("A new post at the bottom.")).toBeInViewport();
  });

  test("a row above the view changing size as the reader scrolls does not move what they are reading", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-windowing-shift-${Date.now()}`,
    });
    await seedPosts(agent.id, ROWS);
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("window-gap").first()).toBeAttached();
    // Park mid-page, away from both ends.
    await scroller(page).evaluate((el) => {
      el.scrollTop = el.scrollHeight / 2;
    });
    await page.waitForTimeout(500);

    // One scroll step, and in the same task a mounted row above the view
    // grows (an image loading, a reply count arriving). The row size
    // change is observed before the scroll event is: the place must still
    // be held against the growth, and the step must still land.
    const moved = await scroller(page).evaluate(async (el) => {
      const view = el.getBoundingClientRect();
      const center = document
        .elementFromPoint(
          view.left + view.width / 2,
          view.top + view.height / 2
        )!
        .closest<HTMLElement>("[data-chat-entry-id]")!;
      const before = center.getBoundingClientRect().top;
      el.scrollTop -= 300;
      const above = [
        ...el.querySelectorAll<HTMLElement>("[data-chat-entry-id]"),
      ].find((row) => row.getBoundingClientRect().bottom < view.top - 50)!;
      above.style.paddingTop = "240px";
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      return Math.round(center.getBoundingClientRect().top - before);
    });
    expect(moved).toBe(300);
  });

  test("browser find and retired full-history preferences cannot disable windowing", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-windowing-find-${Date.now()}`,
    });
    const ids = await seedPosts(agent.id, ROWS);
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await expect(
      page.locator(`[data-chat-entry-id="${ids[ROWS - 1]}"]`)
    ).toBeInViewport();
    await expect.poll(() => mountedRows(page)).toBeLessThan(60);

    await page.keyboard.press("ControlOrMeta+f");
    await expect(page.getByTestId("window-gap").first()).toBeAttached();
    await expect.poll(() => mountedRows(page)).toBeLessThan(60);
    await page.keyboard.press("Escape");

    // An existing browser's saved opt-in must no longer bypass windowing.
    await page.evaluate(() =>
      window.localStorage.setItem("dispatch:stream-full-history", "true")
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.locator(`[data-chat-entry-id="${ids[ROWS - 1]}"]`)
    ).toBeInViewport();
    await expect(page.getByTestId("window-gap").first()).toBeAttached();
    await expect.poll(() => mountedRows(page)).toBeLessThan(60);
    await page.screenshot({
      path: test.info().outputPath("windowed-history.png"),
    });
  });

  test("a reload puts the reader back on the row they were reading", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-windowing-reload-${Date.now()}`,
    });
    await seedPosts(agent.id, ROWS);
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("window-gap").first()).toBeAttached();
    await scroller(page).evaluate((el) => {
      el.scrollTop = el.scrollHeight / 2;
    });
    await page.waitForTimeout(800);
    const before = (await topRow(page))!;
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect
      .poll(async () => {
        const row = page.locator(`[data-chat-entry-id="${before.id}"]`);
        if ((await row.count()) === 0) return null;
        return scroller(page).evaluate(
          (el, id) =>
            Math.round(
              el
                .querySelector(`[data-chat-entry-id="${id}"]`)!
                .getBoundingClientRect().top - el.getBoundingClientRect().top
            ),
          before.id
        );
      })
      .toBe(before.offset);
  });

  test("browser find keeps older loaded pages windowed", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-windowing-find-older-${Date.now()}`,
    });
    await seedPosts(agent.id, ROWS);
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("window-gap").first()).toBeAttached();
    await scroller(page).evaluate((el) => {
      el.scrollTop = 0;
    });
    const heightBefore = await scroller(page).evaluate((el) => el.scrollHeight);
    await scroller(page).getByRole("button", { name: "Load older" }).click();
    await expect
      .poll(() => scroller(page).evaluate((el) => el.scrollHeight))
      .toBeGreaterThan(heightBefore + 3000);
    await page.waitForTimeout(500);

    await page.keyboard.press("ControlOrMeta+f");
    await expect.poll(() => mountedRows(page)).toBeLessThan(60);
    await expect(page.getByTestId("window-gap").first()).toBeAttached();
  });

  test("a reload puts the reader back on a row from an older page", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-windowing-reload-older-${Date.now()}`,
    });
    const ids = await seedPosts(agent.id, ROWS);
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("window-gap").first()).toBeAttached();
    // Two pages of older posts, then park on one from the oldest of them.
    for (let i = 0; i < 2; i += 1) {
      await scroller(page).evaluate((el) => {
        el.scrollTop = 0;
      });
      const height = await scroller(page).evaluate((el) => el.scrollHeight);
      await scroller(page).getByRole("button", { name: "Load older" }).click();
      await expect
        .poll(() => scroller(page).evaluate((el) => el.scrollHeight))
        .toBeGreaterThan(height + 3000);
    }
    await scroller(page).evaluate((el) => {
      el.scrollTop = 600;
    });
    await page.waitForTimeout(800);
    const before = (await topRow(page))!;
    expect(ids.indexOf(before.id)).toBeLessThan(ROWS - 150);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect
      .poll(
        async () => {
          const row = page.locator(`[data-chat-entry-id="${before.id}"]`);
          if ((await row.count()) === 0) return null;
          return scroller(page).evaluate(
            (el, id) =>
              Math.round(
                el
                  .querySelector(`[data-chat-entry-id="${id}"]`)!
                  .getBoundingClientRect().top - el.getBoundingClientRect().top
              ),
            before.id
          );
        },
        { timeout: 15_000 }
      )
      .toBe(before.offset);
  });
});
