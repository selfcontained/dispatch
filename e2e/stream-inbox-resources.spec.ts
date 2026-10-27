import { expect, test } from "@playwright/test";
import {
  callMcpToolViaAPI,
  cleanupE2EAgents,
  createAgentViaAPI,
} from "./helpers";

test.use({ deviceScaleFactor: 2 });

function postedId(response: Record<string, unknown>): string {
  return JSON.parse(
    (response.result as { content: Array<{ text: string }> }).content[0]!.text
  ).id;
}

for (const width of [1280, 390]) {
  test(`typed resources survive generic direct/thread batches and replacement at ${width}px`, async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() =>
      localStorage.setItem("dispatch:chatShowChildAgents", "true")
    );
    const parent = await createAgentViaAPI(request, {
      name: `e2e-resource-parent-${width}-${Date.now()}`,
    });
    const child = await createAgentViaAPI(request, {
      name: "Resource builder",
      parentAgentId: parent.id,
    });
    const unrelated = await createAgentViaAPI(request, {
      name: "Other resource stream",
    });
    const previewUrl = "https://resource.example.test/app";
    const prUrl = "https://resource.example.test/pull/8";
    const openInbox = async () => {
      await expect(
        page.getByTestId("chat-pane").getByTestId("chat-composer-input")
      ).toBeEditable();
      const drawer = page.getByTestId("drawer");
      const opener = page.getByTestId("toggle-drawer");
      if (await opener.isVisible()) await opener.click();
      await expect(drawer.getByTestId("sidebar-tab-inbox")).toBeInViewport();
      await drawer.getByTestId("sidebar-tab-inbox").click();
      return drawer.getByTestId("inbox");
    };
    try {
      await callMcpToolViaAPI(request, unrelated.id, "post", {
        attachments: [
          {
            type: "preview",
            url: "https://resource.example.test/private",
            title: "Other stream preview",
          },
        ],
      });
      await page.goto(`/agents/${parent.id}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.getByTestId("chat-pane")).toBeVisible();
      const direct = postedId(
        await callMcpToolViaAPI(request, parent.id, "post", {
          text: "Resource handoff",
          placement: "home",
          attachments: [
            { type: "preview", url: previewUrl, title: "Web preview" },
            {
              type: "link",
              url: "https://docs.example.test",
              title: "Generic spec",
            },
          ],
        })
      );
      const stream = page.getByTestId("chat-pane");
      await expect(
        stream
          .getByTestId("chat-attachment-preview")
          .getByRole("link", { name: /Preview Web preview/ })
      ).toHaveAttribute("href", previewUrl);
      await expect(
        stream
          .getByTestId("chat-attachment-link")
          .filter({ hasText: "Generic spec" })
      ).toBeVisible();
      const childPost = postedId(
        await callMcpToolViaAPI(request, child.id, "post", {
          placement: "home",
          attachments: [{ type: "pr", url: prUrl, title: "Feature PR" }],
        })
      );
      await expect(
        stream
          .getByTestId("chat-attachment-pr")
          .getByRole("link", { name: /PR Feature PR/ })
      ).toHaveAttribute("href", prUrl);
      const streamScreenshot = `/tmp/dispatch-resources-stream-${width}-${parent.id}.png`;
      await page.screenshot({ path: streamScreenshot, fullPage: true });
      await test.info().attach(`Mixed stream resource cards ${width}`, {
        path: streamScreenshot,
        contentType: "image/png",
      });
      let inbox = await openInbox();
      await expect(inbox.getByTestId("inbox-link")).toHaveCount(2);
      await expect(inbox).not.toContainText("Generic spec");
      await expect(inbox).not.toContainText("Other stream preview");
      // Native links support keyboard navigation. Intercept the synthetic
      // destination so this test never depends on an external service.
      await page
        .context()
        .route("https://resource.example.test/**", (route) =>
          route.fulfill({ body: "Preview destination" })
        );
      const preview = inbox.getByRole("link", { name: /Preview Web preview/ });
      await preview.focus();
      const opened = page.waitForEvent("popup");
      await page.keyboard.press("Enter");
      const popup = await opened;
      await expect(popup).toHaveURL(previewUrl);
      await popup.close();
      // Exact URL duplicates choose the newest resource post, once.
      await callMcpToolViaAPI(request, parent.id, "post", {
        placement: "home",
        attachments: [
          { type: "preview", url: previewUrl, title: "Latest web preview" },
        ],
      });
      await expect(
        inbox.getByRole("link", { name: /Preview Latest web preview/ })
      ).toBeVisible();
      await expect(inbox.getByTestId("inbox-link")).toHaveCount(2);
      // Exceed the direct feed page (100 rows) and old thread supplement (20).
      // Filter before either bound, rather than slicing a generic-link batch.
      for (let offset = 0; offset < 105; offset += 5) {
        await Promise.all(
          Array.from({ length: 5 }, (_, j) =>
            callMcpToolViaAPI(request, parent.id, "post", {
              placement: "home",
              attachments: [
                {
                  type: "link",
                  url: `https://docs.example.test/direct/${offset + j}`,
                },
              ],
            })
          )
        );
      }
      for (let offset = 0; offset < 25; offset += 5) {
        await Promise.all(
          Array.from({ length: 5 }, (_, j) =>
            callMcpToolViaAPI(request, child.id, "post", {
              placement: "home",
              attachments: [
                {
                  type: "link",
                  url: `https://docs.example.test/thread/${offset + j}`,
                },
              ],
            })
          )
        );
      }
      await page.reload({ waitUntil: "domcontentloaded" });
      inbox = await openInbox();
      await expect(inbox.getByTestId("inbox-link")).toHaveCount(2);
      await expect(
        inbox.getByRole("link", { name: /Preview Latest web preview/ })
      ).toBeVisible();
      await expect(
        inbox.getByRole("link", { name: /PR Feature PR/ })
      ).toBeVisible();
      const screenshot = `/tmp/dispatch-resources-${width}-${parent.id}.png`;
      await page.screenshot({ path: screenshot, fullPage: true });
      await test.info().attach(`Resource inbox after batches ${width}`, {
        path: screenshot,
        contentType: "image/png",
      });
      // Replacing types removes stale resource copies in the mounted cache.
      await callMcpToolViaAPI(request, parent.id, "update", {
        id: direct,
        attachments: [
          { type: "link", url: "https://docs.example.test/old-preview" },
        ],
      });
      await expect(
        inbox.getByRole("link", { name: /Preview Latest web preview/ })
      ).toBeVisible();
      await callMcpToolViaAPI(request, child.id, "update", {
        id: childPost,
        attachments: [
          { type: "link", url: "https://docs.example.test/replaced" },
        ],
      });
      await expect(
        inbox.getByRole("link", { name: /PR Feature PR/ })
      ).toHaveCount(0);
      // Child pages remain author-scoped and cannot inherit the root preview.
      await page.goto(`/agents/${child.id}`, { waitUntil: "domcontentloaded" });
      inbox = await openInbox();
      await expect(inbox.getByTestId("inbox-link")).toHaveCount(0);
      await callMcpToolViaAPI(request, child.id, "update", {
        id: childPost,
        attachments: [
          {
            type: "preview",
            url: "https://resource.example.test/child",
            title: "Child preview",
          },
        ],
      });
      await expect(
        inbox.getByRole("link", { name: /Preview Child preview/ })
      ).toBeVisible();
      await expect(inbox).not.toContainText("Latest web preview");
      await page.reload({ waitUntil: "domcontentloaded" });
      inbox = await openInbox();
      await expect(inbox.getByTestId("inbox-link")).toHaveCount(1);
      const childScreenshot = `/tmp/dispatch-resources-child-${width}-${parent.id}.png`;
      await page.screenshot({ path: childScreenshot, fullPage: true });
      await test.info().attach(`Child resource after replacement ${width}`, {
        path: childScreenshot,
        contentType: "image/png",
      });
    } finally {
      await cleanupE2EAgents(request);
    }
  });
}
