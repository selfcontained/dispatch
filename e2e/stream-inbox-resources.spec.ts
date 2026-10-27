import { expect, test, type Locator } from "@playwright/test";
import {
  authHeaders,
  callMcpToolViaAPI,
  uploadFileViaAPI,
  uploadTextFileViaAPI,
  cleanupE2EAgents,
  createAgentViaAPI,
} from "./helpers";

test.use({ deviceScaleFactor: 2 });

function postedId(response: Record<string, unknown>): string {
  return JSON.parse(
    (response.result as { content: Array<{ text: string }> }).content[0]!.text
  ).id;
}

for (const width of [1280, 700, 390]) {
  test(`typed resources survive generic direct/thread batches and replacement at ${width}px`, async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const capture = async (path: string) => {
      await page.waitForFunction(() =>
        document
          .getAnimations()
          .every(
            (animation) =>
              animation.effect?.getComputedTiming().iterations === Infinity ||
              animation.playState !== "running"
          )
      );
      await page.screenshot({ path, fullPage: true });
    };
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
    const expectFullContentWidth = async (cards: Locator) => {
      await expect
        .poll(() =>
          cards.evaluateAll((elements) =>
            elements.every((element) => {
              const card = element.getBoundingClientRect();
              const parent = element.parentElement!;
              const container = parent.getBoundingClientRect();
              const style = getComputedStyle(parent);
              const left = container.left + parseFloat(style.paddingLeft);
              const width =
                container.width -
                parseFloat(style.paddingLeft) -
                parseFloat(style.paddingRight);
              return (
                Math.abs(card.left - left) < 1 &&
                Math.abs(card.width - width) < 1
              );
            })
          )
        )
        .toBe(true);
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
            { type: "pr", url: prUrl, title: "Direct PR" },
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
      const mixedList = stream.getByTestId("chat-attachment-list").filter({
        has: page.getByRole("link", { name: /Preview Web preview/ }),
      });
      const mixedCards = mixedList.locator(":scope > div");
      await expect(mixedCards).toHaveCount(3);
      if (width >= 768) {
        // Compact intrinsic widths let all three kinds occupy one flex row.
        await expect
          .poll(() =>
            mixedCards.evaluateAll((elements) => {
              const boxes = elements.map((element) =>
                element.getBoundingClientRect()
              );
              return (
                boxes.every((box) => Math.abs(box.top - boxes[0]!.top) < 1) &&
                boxes.every((box) => box.height < 44) &&
                boxes[1]!.left > boxes[0]!.right
              );
            })
          )
          .toBe(true);
      } else {
        await expectFullContentWidth(mixedCards);
        await expectFullContentWidth(
          stream
            .getByTestId("chat-attachment-pr")
            .filter({ hasText: "Feature PR" })
        );
      }
      await callMcpToolViaAPI(request, parent.id, "post", {
        placement: "home",
        link: {
          url: "https://docs.example.test/standalone",
          title: "Standalone link",
        },
      });
      const standalone = stream
        .getByTestId("chat-link-block-card")
        .filter({ hasText: "Standalone link" });
      await expect(standalone).toBeVisible();
      if (width < 768) await expectFullContentWidth(standalone);
      await page.waitForFunction(() =>
        document
          .getAnimations()
          .every(
            (animation) =>
              animation.effect?.getComputedTiming().iterations === Infinity ||
              animation.playState !== "running"
          )
      );
      const streamScreenshot = `/tmp/dispatch-resources-stream-${width}-${parent.id}.png`;
      await capture(streamScreenshot);
      await test.info().attach(`Mixed stream resource cards ${width}`, {
        path: streamScreenshot,
        contentType: "image/png",
      });
      // Long labels stay inside each card instead of widening the stream.
      await callMcpToolViaAPI(request, parent.id, "update", {
        id: direct,
        attachments: [
          {
            type: "preview",
            url: previewUrl,
            title: `Web preview — ${"long preview title ".repeat(7)}`,
          },
          {
            type: "pr",
            url: prUrl,
            title: `Direct PR — ${"long pull request title ".repeat(6)}`,
          },
          {
            type: "link",
            url: "https://docs.example.test",
            title: `Generic spec — ${"long reference title ".repeat(7)}`,
          },
        ],
      });
      await expect(mixedList).toContainText("long preview title");
      await expect
        .poll(() =>
          mixedCards.evaluateAll((elements) =>
            elements.every((element) => {
              const label = element.querySelector("span.truncate")!;
              return (
                label.scrollWidth > label.clientWidth &&
                element.getBoundingClientRect().width <=
                  element.parentElement!.getBoundingClientRect().width
              );
            })
          )
        )
        .toBe(true);
      if (width < 768) await expectFullContentWidth(mixedCards);
      const longScreenshot = `/tmp/dispatch-resources-long-${width}-${parent.id}.png`;
      await capture(longScreenshot);
      await test.info().attach(`Long URL card titles ${width}`, {
        path: longScreenshot,
        contentType: "image/png",
      });
      await callMcpToolViaAPI(request, parent.id, "update", {
        id: direct,
        attachments: [
          { type: "preview", url: previewUrl, title: "Web preview" },
          { type: "pr", url: prUrl, title: "Direct PR" },
          {
            type: "link",
            url: "https://docs.example.test",
            title: "Generic spec",
          },
        ],
      });
      // Non-URL attachments remain ordered separate rows with their original
      // file/gallery/code layouts, rather than joining the compact URL row.
      await Promise.all([
        uploadFileViaAPI(
          request,
          parent.id,
          "First layout image",
          "layout-first.png"
        ),
        uploadFileViaAPI(
          request,
          parent.id,
          "Second layout image",
          "layout-second.png"
        ),
        uploadTextFileViaAPI(
          request,
          parent.id,
          "Layout report",
          "Layout details",
          "layout-report.md"
        ),
      ]);
      const filesResponse = await request.get(
        `/api/v1/agents/${parent.id}/files`,
        { headers: authHeaders() }
      );
      const { files } = (await filesResponse.json()) as {
        files: Array<{ id: number; name: string }>;
      };
      await callMcpToolViaAPI(request, parent.id, "post", {
        placement: "home",
        attachments: [
          {
            type: "link",
            url: "https://docs.example.test/before",
            title: "Before media",
          },
          {
            type: "file",
            fileId: files.find((file) => file.name.startsWith("layout-first"))!
              .id,
          },
          {
            type: "file",
            fileId: files.find((file) => file.name.startsWith("layout-second"))!
              .id,
          },
          {
            type: "file",
            fileId: files.find((file) => file.name.startsWith("layout-report"))!
              .id,
          },
          { type: "code", code: "const layout = 'preserved';", language: "ts" },
          {
            type: "link",
            url: "https://docs.example.test/after",
            title: "After media",
          },
        ],
      });
      const mediaList = stream
        .getByTestId("chat-attachment-list")
        .filter({ has: page.getByRole("link", { name: /Before media/ }) });
      await expect(
        mediaList.getByTestId("chat-attachment-gallery-tile")
      ).toHaveCount(2);
      await expect(mediaList.getByTestId("chat-attachment-file")).toBeVisible();
      await expect(mediaList.getByTestId("chat-attachment-code")).toContainText(
        "preserved"
      );
      await expect
        .poll(() =>
          mediaList.locator(":scope > div").evaluateAll((elements) => {
            const boxes = elements.map((element) =>
              element.getBoundingClientRect()
            );
            return (
              boxes.length === 5 &&
              boxes.every(
                (box, index) =>
                  index === 0 || box.top >= boxes[index - 1]!.bottom - 1
              )
            );
          })
        )
        .toBe(true);
      const mediaScreenshot = `/tmp/dispatch-resources-media-${width}-${parent.id}.png`;
      await capture(mediaScreenshot);
      await test
        .info()
        .attach(`URL cards around media file and code ${width}`, {
          path: mediaScreenshot,
          contentType: "image/png",
        });
      let inbox = await openInbox();
      await expect(inbox.getByTestId("inbox-link")).toHaveCount(2);
      await expectFullContentWidth(inbox.getByTestId("inbox-link"));
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
      await capture(screenshot);
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
      await capture(childScreenshot);
      await test.info().attach(`Child resource after replacement ${width}`, {
        path: childScreenshot,
        contentType: "image/png",
      });
    } finally {
      await cleanupE2EAgents(request);
    }
  });
}
