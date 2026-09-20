import { expect, test, type Page } from "@playwright/test";

import {
  authHeaders,
  cleanupE2EAgents,
  clickAgentRow,
  createAgentViaAPI,
  loadApp,
  seedBlockViaDB,
  uploadFileViaAPI,
  uploadTextFileViaAPI,
} from "./helpers";

const API = "/api/v1";

async function openDrawerForAgent(
  page: Page,
  agent: { id: string; name: string }
) {
  await clickAgentRow(page, agent.id);
  const toggle = page.getByTestId("toggle-drawer");
  await expect(toggle).toBeVisible();
  await toggle.click();
}

test.describe("Drawer", () => {
  test.afterAll(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("refreshes cached files when switching back to an agent", async ({
    page,
    request,
  }) => {
    const firstAgent = await createAgentViaAPI(request, {
      name: `e2e-agent-files-a-${Date.now()}`,
    });
    const secondAgent = await createAgentViaAPI(request, {
      name: `e2e-agent-files-b-${Date.now()}`,
    });

    await uploadFileViaAPI(
      request,
      firstAgent.id,
      "First image",
      "first-image.png"
    );

    await loadApp(page);

    await openDrawerForAgent(page, firstAgent);

    const drawer = page.getByTestId("drawer");
    await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name: "Files" }).click();
    await expect(drawer.getByText("First image")).toBeVisible();

    await clickAgentRow(page, secondAgent.id);
    await uploadFileViaAPI(
      request,
      firstAgent.id,
      "Second image",
      "second-image.png"
    );
    await clickAgentRow(page, firstAgent.id);

    await expect(drawer.getByText("Second image")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("remembers sidebar open state and active tab per agent", async ({
    page,
    request,
  }) => {
    const firstAgent = await createAgentViaAPI(request, {
      name: `e2e-agent-sidebar-state-a-${Date.now()}`,
      cwd: process.cwd(),
    });
    const secondAgent = await createAgentViaAPI(request, {
      name: `e2e-agent-sidebar-state-b-${Date.now()}`,
      cwd: process.cwd(),
    });

    // Agent B has an open question, so its Rail has something to show.
    await seedBlockViaDB({
      streamId: secondAgent.id,
      authorKind: "agent",
      kind: "question",
      text: "Question for agent B",
      data: { options: [{ label: "Yes" }, { label: "No" }] },
      state: {},
    });
    await uploadFileViaAPI(
      request,
      firstAgent.id,
      "Remembered image",
      "remembered-image.png"
    );

    await loadApp(page);

    await openDrawerForAgent(page, firstAgent);
    const drawer = page.getByTestId("drawer");
    await drawer.getByRole("button", { name: "Files" }).click();
    await expect(drawer.getByText("Remembered image")).toBeVisible();

    await clickAgentRow(page, secondAgent.id);
    await page.getByTestId("toggle-drawer").click();
    await drawer.getByTestId("sidebar-tab-rail").click();
    await expect(drawer.getByText("Question for agent B")).toBeVisible();

    await clickAgentRow(page, firstAgent.id);
    await expect(page.getByTestId("toggle-drawer")).toBeHidden();
    await expect(drawer.getByText("Remembered image")).toBeVisible();

    await clickAgentRow(page, secondAgent.id);
    await expect(page.getByTestId("toggle-drawer")).toBeHidden();
    await expect(drawer.getByText("Question for agent B")).toBeVisible();
  });

  test("navigates between fullscreen file items", async ({ page, request }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-lightbox-${Date.now()}`,
    });

    await uploadFileViaAPI(request, agent.id, "First image", "first-image.png");
    await uploadFileViaAPI(
      request,
      agent.id,
      "Second image",
      "second-image.png"
    );

    await loadApp(page);

    await openDrawerForAgent(page, agent);

    const drawer = page.getByTestId("drawer");
    await drawer.getByRole("button", { name: "Files" }).click();

    await drawer.getByRole("button", { name: "Second image" }).click();

    const lightbox = page.getByTestId("file-lightbox");
    await expect(lightbox).toBeVisible();
    await expect(lightbox).toContainText("1/2");
    await expect(lightbox).toContainText("Second image");

    const imageViewport = page.getByTestId("file-lightbox-image-viewport");
    await expect(imageViewport).toBeVisible();
    await expect(imageViewport).toHaveCSS("touch-action", "none");
    await expect(page.getByTestId("file-lightbox-zoom-reset")).toHaveText(
      "100%"
    );

    await page.getByTestId("file-lightbox-zoom-in").click();
    await expect(page.getByTestId("file-lightbox-zoom-reset")).toHaveText(
      "150%"
    );
    await page.getByTestId("file-lightbox-zoom-reset").click();

    await page.getByTestId("file-lightbox-zoom-in").dblclick();
    await expect(page.getByTestId("file-lightbox-zoom-reset")).toHaveText(
      "225%"
    );
    await page.getByTestId("file-lightbox-zoom-reset").dblclick();
    await expect(page.getByTestId("file-lightbox-zoom-reset")).toHaveText(
      "100%"
    );

    await imageViewport.dispatchEvent("pointerdown", {
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      clientX: 280,
      clientY: 300,
    });
    await imageViewport.dispatchEvent("pointermove", {
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      clientX: 120,
      clientY: 305,
    });
    await imageViewport.dispatchEvent("pointerup", {
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      clientX: 120,
      clientY: 305,
    });
    await expect(lightbox).toContainText("2/2");
    await expect(lightbox).toContainText("First image");

    await page.getByTestId("file-lightbox-prev").click();
    await expect(lightbox).toContainText("1/2");
    await expect(lightbox).toContainText("Second image");

    await page.keyboard.press("ArrowRight");
    await expect(lightbox).toContainText("2/2");

    await lightbox.getByRole("button", { name: "Close" }).click();
    await expect(lightbox).toBeHidden();
  });

  test("renders Mermaid diagrams in shared markdown lightbox", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-mermaid-${Date.now()}`,
    });

    await uploadTextFileViaAPI(
      request,
      agent.id,
      "Architecture note",
      [
        "# Diagram",
        "",
        "```mermaid",
        "flowchart TD",
        "  Agent[Agent] --> Viewer[Lightbox]",
        "```",
        "",
        "Rendered inline.",
      ].join("\n"),
      "architecture.md"
    );

    await loadApp(page);
    await openDrawerForAgent(page, agent);

    const drawer = page.getByTestId("drawer");
    await drawer.getByRole("button", { name: "Files" }).click();
    await drawer.getByRole("button", { name: /architecture\.md/i }).click();

    const lightbox = page.getByTestId("file-lightbox");
    await expect(lightbox).toBeVisible();
    await expect(lightbox.getByText("Diagram", { exact: true })).toBeVisible();
    await expect(lightbox.getByText("Rendered inline.")).toBeVisible();

    const mermaidDiagram = lightbox.getByTestId("mermaid-diagram");
    await expect(mermaidDiagram).toBeVisible();
    await expect(
      mermaidDiagram.locator("svg[aria-roledescription]").first()
    ).toBeVisible();
    await expect(mermaidDiagram).toContainText("Agent");
    await expect(mermaidDiagram).toContainText("Lightbox");

    await expect(page.getByTestId("copy-mermaid-source")).toBeVisible();
    await expect(page.getByTestId("copy-mermaid-svg")).toBeVisible();
  });

  test("renders shared HTML in a sandboxed lightbox preview", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-html-${Date.now()}`,
    });

    await uploadTextFileViaAPI(
      request,
      agent.id,
      "Prototype page",
      "<h1>Hello from HTML</h1><script>document.title='ran'</script>",
      "prototype.html"
    );

    await loadApp(page);
    await openDrawerForAgent(page, agent);

    const drawer = page.getByTestId("drawer");
    await drawer.getByRole("button", { name: "Files" }).click();
    await drawer.getByRole("button", { name: /prototype\.html/i }).click();

    const lightbox = page.getByTestId("file-lightbox");
    await expect(lightbox).toBeVisible();

    const frame = lightbox.getByTestId("file-lightbox-html");
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute(
      "sandbox",
      "allow-scripts allow-popups"
    );
    await expect(
      frame.contentFrame().getByRole("heading", { name: "Hello from HTML" })
    ).toBeVisible();

    const openTab = page.getByTestId("file-lightbox-open-tab");
    await expect(openTab).toBeVisible();
    await expect(openTab).toHaveAttribute("target", "_blank");
    await expect(openTab).toHaveAttribute(
      "href",
      /\/files\/prototype-.*\.html/
    );
  });

  test("copies Mermaid source and SVG from diagram actions", async ({
    page,
    request,
  }) => {
    await page.addInitScript(() => {
      let copied = "";
      Object.defineProperty(window, "__dispatchCopiedText", {
        configurable: true,
        get: () => copied,
        set: (value: string) => {
          copied = value;
        },
      });

      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            copied = value;
          },
        },
      });
    });

    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-mermaid-copy-${Date.now()}`,
    });

    const source = ["flowchart TD", "  Agent[Agent] --> Viewer[Lightbox]"].join(
      "\n"
    );

    await uploadTextFileViaAPI(
      request,
      agent.id,
      "Architecture note",
      ["# Diagram", "", "```mermaid", source, "```"].join("\n"),
      "architecture.md"
    );

    await loadApp(page);
    await openDrawerForAgent(page, agent);

    const drawer = page.getByTestId("drawer");
    await drawer.getByRole("button", { name: "Files" }).click();
    await drawer.getByRole("button", { name: /architecture\.md/i }).click();

    const lightbox = page.getByTestId("file-lightbox");
    await expect(lightbox).toBeVisible();
    await expect(lightbox.getByTestId("mermaid-diagram")).toBeVisible();

    await page.getByTestId("copy-mermaid-source").click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as Window & { __dispatchCopiedText?: string })
              .__dispatchCopiedText ?? ""
        )
      )
      .toBe(source);

    await page.getByTestId("copy-mermaid-svg").click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as Window & { __dispatchCopiedText?: string })
              .__dispatchCopiedText ?? ""
        )
      )
      .toContain("<svg");
  });

  test("marks visible files as seen and persists to server", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-seen-${Date.now()}`,
    });

    await uploadFileViaAPI(
      request,
      agent.id,
      "Seen test image",
      "seen-test.png"
    );

    await loadApp(page);
    await openDrawerForAgent(page, agent);

    const drawer = page.getByTestId("drawer");
    await drawer.getByRole("button", { name: "Files" }).click();

    // The item should flip to "seen" once visible (IntersectionObserver fires).
    const thumb = drawer.locator(".file-thumb-seen");
    await expect(thumb).toBeVisible({ timeout: 5_000 });

    // Verify it persisted to the server. The client flips the cache
    // optimistically and fires the POST async — under CI's slower clock the
    // server may not have recorded the seen state by the time the DOM
    // assertion above resolves, so poll instead of expecting instant
    // convergence.
    await expect
      .poll(
        async () => {
          const res = await request.get(`/api/v1/agents/${agent.id}/files`, {
            headers: {
              Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
            },
          });
          const body = (await res.json()) as {
            files: Array<{ seen?: boolean }>;
          };
          return body.files[0]?.seen === true;
        },
        { timeout: 5_000 }
      )
      .toBe(true);
  });

  test("groups a sub agent's files under its parent", async ({
    page,
    request,
  }) => {
    const parent = await createAgentViaAPI(request, {
      name: `e2e-agent-family-parent-${Date.now()}`,
    });
    const child = await createAgentViaAPI(request, {
      name: `e2e-agent-family-child-${Date.now()}`,
      parentAgentId: parent.id,
    });
    await uploadFileViaAPI(
      request,
      child.id,
      "Child screenshot",
      "child-shot.png"
    );
    await loadApp(page);
    await openDrawerForAgent(page, parent);
    const drawer = page.getByTestId("drawer");
    await expect(drawer).toBeVisible();

    // Files tab: a dropdown at the top picks whose files show. The child's
    // file is still addressed to the child (data-files-owner) so seen-
    // tracking posts against the child rather than the parent.
    await drawer.getByRole("button", { name: "Files" }).click();
    const ownerSwitch = drawer.getByTestId("files-owner-switch");
    await expect(ownerSwitch).toHaveAttribute("data-owner", parent.id);
    await expect(drawer.getByText("Child screenshot")).toHaveCount(0);
    await ownerSwitch.click();
    await page.getByTestId(`files-owner-option-${child.id}`).click();
    await expect(ownerSwitch).toHaveAttribute("data-owner", child.id);
    await expect(drawer.getByText("Child screenshot")).toBeVisible();
    await expect(
      drawer.locator(`[data-files-owner="${child.id}"]`)
    ).toHaveCount(1);
    await expect
      .poll(async () => {
        const res = await request.get(`${API}/agents/${child.id}/files`, {
          headers: authHeaders(),
        });
        const body = (await res.json()) as { files: { seen: boolean }[] };
        return body.files[0]?.seen ?? false;
      })
      .toBe(true);

    // The child's own panel is unchanged: no groups, its file already seen.
    // Switching agents closes the drawer, so reopen it for the child.
    await page.getByTestId(`child-agent-row-${child.id}`).click();
    await page.getByTestId("toggle-drawer").click();
    await drawer.getByRole("button", { name: "Files" }).click();
    await expect(drawer.getByText("Child screenshot")).toBeVisible();
    await expect(drawer.getByTestId("sub-agent-files-group")).toHaveCount(0);
  });

  test("mobile: Escape closes the owner menu, not the whole files sheet", async ({
    page,
    request,
  }) => {
    const parent = await createAgentViaAPI(request, {
      name: `e2e-agent-family-mobile-parent-${Date.now()}`,
    });
    await createAgentViaAPI(request, {
      name: `e2e-agent-family-mobile-child-with-a-deliberately-long-name-${Date.now()}`,
      parentAgentId: parent.id,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await loadApp(page);
    // The agent list is a sheet on mobile; the route focuses the agent directly.
    await page.goto(`/agents/${parent.id}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("toggle-drawer").click();
    const sheet = page.getByRole("dialog", { name: "Drawer" });
    await expect(sheet).toBeVisible();
    const drawer = sheet.getByTestId("drawer");
    await drawer.getByRole("button", { name: "Files" }).click();

    const ownerSwitch = drawer.getByTestId("files-owner-switch");
    await ownerSwitch.click();
    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();
    // Sized to the trigger, so a long agent name cannot push it off-screen.
    const box = await listbox.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);

    await page.keyboard.press("Escape");
    await expect(listbox).toHaveCount(0);
    await expect(sheet).toBeVisible();
  });

  test("the closed unpinned drawer adds no scrollable overflow to the app row", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-drawer-overflow-${Date.now()}`,
      cwd: process.cwd(),
    });
    await loadApp(page);
    await openDrawerForAgent(page, agent);
    const wrapper = page.getByTestId("drawer-wrapper");
    await expect(wrapper).toHaveAttribute("data-pinned", "false");

    await page
      .getByTestId("drawer")
      .getByRole("button", { name: "Close sidebar" })
      .click();
    await expect
      .poll(() => wrapper.evaluate((node) => node.getBoundingClientRect().left))
      .toBeGreaterThanOrEqual(page.viewportSize()!.width);

    // The closed drawer parks off-canvas to the right. Anchored to the
    // viewport it contributes nothing to the app row; as an absolute child it
    // gave the row 400px of scroll overflow, and any `scrollIntoView` inside
    // the drawer then scrolled the row and dragged the whole app sideways.
    const measure = () =>
      page.evaluate(() => {
        const main = document.querySelector("main")!;
        const row = main.parentElement!;
        return {
          overflowing: row.scrollWidth > row.clientWidth,
          scrollLeft: row.scrollLeft,
          mainLeft: Math.round(main.getBoundingClientRect().left),
        };
      });
    const before = await measure();
    expect(before.overflowing).toBe(false);

    await page
      .getByTestId("drawer")
      .getByTestId("stream-rail-empty")
      .evaluate((node) =>
        node.scrollIntoView({ block: "nearest", inline: "nearest" })
      );

    expect(await measure()).toEqual(before);
  });
});
