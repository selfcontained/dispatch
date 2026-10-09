import { expect, test } from "@playwright/test";

import { cleanupE2EAgents, createAgentViaAPI, seedBlockViaDB } from "./helpers";

test.use({ deviceScaleFactor: 2 });

for (const width of [390, 1280]) {
  test(`markdown tables keep readable columns at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const agent = await createAgentViaAPI(request, {
      name: `e2e-markdown-table-${width}-${Date.now()}`,
    });
    try {
      await seedBlockViaDB({
        streamId: agent.id,
        authorKind: "agent",
        text: `Tables keep labels readable and descriptions wrap at words.

| Layer | Shared responsibility |
| --- | --- |
| ACP client | Session setup/resume, prompts, cancellation, capability negotiation, tool updates, permission requests and engine quirks |
| Stream core | Assemble events into turns/messages, accumulate text, update tool activity, associate artifacts, track delivery receipts and apply block state changes |
| Stream UI | Render that model and expose interaction callbacks |

| A | B |
| --- | --- |
| 1 | 2 |

| Identifier | Status | Owner | Purpose |
| --- | --- | --- | --- |
| ${"very_long_unbroken_identifier_".repeat(5)} | Running | Example owner | Check horizontal scrolling without widening the page |`,
      });
      await page.goto(`/agents/${agent.id}`, {
        waitUntil: "domcontentloaded",
      });
      const tables = page.getByTestId("markdown-table-scroll");
      await expect(tables).toHaveCount(3);
      const readable = tables.nth(0);
      await readable.evaluate((el) => el.scrollIntoView({ block: "nearest" }));
      const measure = () =>
        readable.evaluate((wrapper) => {
          const table = wrapper.querySelector("table")!;
          const labels = [...table.querySelectorAll("tr > :first-child")];
          return {
            availableWidth: wrapper.clientWidth,
            widths: labels.map((cell) => cell.getBoundingClientRect().width),
            lines: labels.map((cell) => {
              const range = document.createRange();
              range.selectNodeContents(cell);
              return new Set(
                [...range.getClientRects()].map((rect) => rect.top)
              ).size;
            }),
            descriptionWidth: table
              .querySelector("td:nth-child(2)")!
              .getBoundingClientRect().width,
          };
        });
      // The browser may defer text layout as this surface scrolls into view.
      // Capture and validate one rendered measurement before checking widths.
      let layout = await measure();
      await expect
        .poll(async () => {
          layout = await measure();
          return layout.lines;
        })
        .toEqual([1, 1, 1, 1]);
      expect(Math.min(...layout.widths)).toBeGreaterThan(70);
      expect(layout.descriptionWidth).toBeLessThanOrEqual(
        Math.max(550, layout.availableWidth)
      );

      // Short tables should still fit, and only wide tables should scroll.
      expect(
        await tables.nth(1).evaluate((el) => el.scrollWidth - el.clientWidth)
      ).toBeLessThanOrEqual(1);
      const wide = tables.nth(2);
      const textOverflow = await wide.evaluate((wrapper) => {
        let overflow = 0;
        for (const cell of wrapper.querySelectorAll("th, td")) {
          const bounds = cell.getBoundingClientRect();
          const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const range = document.createRange();
            range.selectNodeContents(walker.currentNode);
            for (const rect of range.getClientRects()) {
              overflow = Math.max(
                overflow,
                bounds.left - rect.left,
                rect.right - bounds.right
              );
            }
          }
        }
        return overflow;
      });
      expect(textOverflow).toBeLessThanOrEqual(1);
      await wide.evaluate((el) => el.scrollIntoView({ block: "nearest" }));
      // Attaching a session can remount its feed after the first render.
      // Exercise the wheel on the current scroller once that settles.
      await expect(async () => {
        await wide.hover();
        await page.mouse.wheel(600, 0);
        await expect
          .poll(() => wide.evaluate((el) => el.scrollLeft), { timeout: 1000 })
          .toBeGreaterThan(0);
      }).toPass({ timeout: 10000 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth
        )
      ).toBeLessThanOrEqual(1);
      await wide.evaluate((el) => {
        el.scrollLeft = 0;
      });
      await page.screenshot({
        path: `/tmp/dispatch-markdown-long-token-${width}.png`,
      });
      await readable.evaluate((el) => el.scrollIntoView({ block: "nearest" }));
      await page.screenshot({
        path: `/tmp/dispatch-markdown-tables-${width}.png`,
      });
    } finally {
      await cleanupE2EAgents(request);
    }
  });
}
