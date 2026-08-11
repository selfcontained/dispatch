import { expect, test, type Page } from "@playwright/test";

import {
  cleanupE2EAgents,
  clickAgentRow,
  createAgentViaAPI,
  loadApp,
  setAgentPinsViaDB,
  uploadMediaViaAPI,
  uploadTextMediaViaAPI,
} from "./helpers";

async function openMediaSidebarForAgent(
  page: Page,
  agent: { id: string; name: string }
) {
  await clickAgentRow(page, agent.id);
  const toggle = page.getByTestId("toggle-media-sidebar");
  await expect(toggle).toBeVisible();
  await toggle.click();
}

test.describe("Media sidebar", () => {
  test.afterAll(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("refreshes cached media when switching back to an agent", async ({
    page,
    request,
  }) => {
    const firstAgent = await createAgentViaAPI(request, {
      name: `e2e-agent-media-a-${Date.now()}`,
    });
    const secondAgent = await createAgentViaAPI(request, {
      name: `e2e-agent-media-b-${Date.now()}`,
    });

    await uploadMediaViaAPI(
      request,
      firstAgent.id,
      "First image",
      "first-image.png"
    );

    await loadApp(page);

    await openMediaSidebarForAgent(page, firstAgent);

    const mediaSidebar = page.getByTestId("media-sidebar");
    await expect(mediaSidebar).toBeVisible();
    await mediaSidebar.getByRole("button", { name: "Media" }).click();
    await expect(mediaSidebar.getByText("First image")).toBeVisible();

    await clickAgentRow(page, secondAgent.id);
    await uploadMediaViaAPI(
      request,
      firstAgent.id,
      "Second image",
      "second-image.png"
    );
    await clickAgentRow(page, firstAgent.id);

    await expect(mediaSidebar.getByText("Second image")).toBeVisible({
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

    await setAgentPinsViaDB(firstAgent.id, [
      { label: "First pin", type: "string", value: "Pinned for agent A" },
    ]);
    await setAgentPinsViaDB(secondAgent.id, [
      { label: "Second pin", type: "string", value: "Pinned for agent B" },
    ]);
    await uploadMediaViaAPI(
      request,
      firstAgent.id,
      "Remembered image",
      "remembered-image.png"
    );

    await loadApp(page);

    await openMediaSidebarForAgent(page, firstAgent);
    const mediaSidebar = page.getByTestId("media-sidebar");
    await mediaSidebar.getByRole("button", { name: "Media" }).click();
    await expect(mediaSidebar.getByText("Remembered image")).toBeVisible();

    await clickAgentRow(page, secondAgent.id);
    await page.getByTestId("toggle-media-sidebar").click();
    await mediaSidebar.getByRole("button", { name: "Pins" }).click();
    await expect(mediaSidebar.getByText("Pinned for agent B")).toBeVisible();

    await clickAgentRow(page, firstAgent.id);
    await expect(page.getByTestId("toggle-media-sidebar")).toBeHidden();
    await expect(mediaSidebar.getByText("Remembered image")).toBeVisible();

    await clickAgentRow(page, secondAgent.id);
    await expect(page.getByTestId("toggle-media-sidebar")).toBeHidden();
    await expect(mediaSidebar.getByText("Pinned for agent B")).toBeVisible();
  });

  test("navigates between fullscreen media items", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-lightbox-${Date.now()}`,
    });

    await uploadMediaViaAPI(
      request,
      agent.id,
      "First image",
      "first-image.png"
    );
    await uploadMediaViaAPI(
      request,
      agent.id,
      "Second image",
      "second-image.png"
    );

    await loadApp(page);

    await openMediaSidebarForAgent(page, agent);

    const mediaSidebar = page.getByTestId("media-sidebar");
    await mediaSidebar.getByRole("button", { name: "Media" }).click();

    await mediaSidebar.getByRole("button", { name: "Second image" }).click();

    const lightbox = page.getByTestId("media-lightbox");
    await expect(lightbox).toBeVisible();
    await expect(lightbox).toContainText("1/2");
    await expect(lightbox).toContainText("Second image");

    const imageViewport = page.getByTestId("media-lightbox-image-viewport");
    await expect(imageViewport).toBeVisible();
    await expect(imageViewport).toHaveCSS("touch-action", "none");
    await expect(page.getByTestId("media-lightbox-zoom-reset")).toHaveText(
      "100%"
    );

    await page.getByTestId("media-lightbox-zoom-in").click();
    await expect(page.getByTestId("media-lightbox-zoom-reset")).toHaveText(
      "150%"
    );
    await page.getByTestId("media-lightbox-zoom-reset").click();

    await page.getByTestId("media-lightbox-zoom-in").dblclick();
    await expect(page.getByTestId("media-lightbox-zoom-reset")).toHaveText(
      "225%"
    );
    await page.getByTestId("media-lightbox-zoom-reset").dblclick();
    await expect(page.getByTestId("media-lightbox-zoom-reset")).toHaveText(
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

    await page.getByTestId("media-lightbox-prev").click();
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

    await uploadTextMediaViaAPI(
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
    await openMediaSidebarForAgent(page, agent);

    const mediaSidebar = page.getByTestId("media-sidebar");
    await mediaSidebar.getByRole("button", { name: "Media" }).click();
    await mediaSidebar
      .getByRole("button", { name: /architecture\.md/i })
      .click();

    const lightbox = page.getByTestId("media-lightbox");
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

    await uploadTextMediaViaAPI(
      request,
      agent.id,
      "Prototype page",
      "<h1>Hello from HTML</h1><script>document.title='ran'</script>",
      "prototype.html"
    );

    await loadApp(page);
    await openMediaSidebarForAgent(page, agent);

    const mediaSidebar = page.getByTestId("media-sidebar");
    await mediaSidebar.getByRole("button", { name: "Media" }).click();
    await mediaSidebar
      .getByRole("button", { name: /prototype\.html/i })
      .click();

    const lightbox = page.getByTestId("media-lightbox");
    await expect(lightbox).toBeVisible();

    const frame = lightbox.getByTestId("media-lightbox-html");
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute(
      "sandbox",
      "allow-scripts allow-popups"
    );
    await expect(
      frame.contentFrame().getByRole("heading", { name: "Hello from HTML" })
    ).toBeVisible();

    const openTab = page.getByTestId("media-lightbox-open-tab");
    await expect(openTab).toBeVisible();
    await expect(openTab).toHaveAttribute("target", "_blank");
    await expect(openTab).toHaveAttribute(
      "href",
      /\/media\/prototype-.*\.html/
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

    await uploadTextMediaViaAPI(
      request,
      agent.id,
      "Architecture note",
      ["# Diagram", "", "```mermaid", source, "```"].join("\n"),
      "architecture.md"
    );

    await loadApp(page);
    await openMediaSidebarForAgent(page, agent);

    const mediaSidebar = page.getByTestId("media-sidebar");
    await mediaSidebar.getByRole("button", { name: "Media" }).click();
    await mediaSidebar
      .getByRole("button", { name: /architecture\.md/i })
      .click();

    const lightbox = page.getByTestId("media-lightbox");
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

  test("marks visible media as seen and persists to server", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-seen-${Date.now()}`,
    });

    await uploadMediaViaAPI(
      request,
      agent.id,
      "Seen test image",
      "seen-test.png"
    );

    await loadApp(page);
    await openMediaSidebarForAgent(page, agent);

    const mediaSidebar = page.getByTestId("media-sidebar");
    await mediaSidebar.getByRole("button", { name: "Media" }).click();

    // The item should flip to "seen" once visible (IntersectionObserver fires).
    const thumb = mediaSidebar.locator(".media-thumb-seen");
    await expect(thumb).toBeVisible({ timeout: 5_000 });

    // Verify it persisted to the server. The client flips the cache
    // optimistically and fires the POST async — under CI's slower clock the
    // server may not have recorded the seen state by the time the DOM
    // assertion above resolves, so poll instead of expecting instant
    // convergence.
    await expect
      .poll(
        async () => {
          const res = await request.get(`/api/v1/agents/${agent.id}/media`, {
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

  test("preserves string pin whitespace and splits filename pins", async ({
    page,
    request,
  }) => {
    const workspaceRoot = process.cwd();
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-pins-${Date.now()}`,
      cwd: workspaceRoot,
    });
    await setAgentPinsViaDB(agent.id, [
      { label: "Notes", type: "string", value: "line 1\n\n  line 2" },
      {
        label: "Summary",
        type: "markdown",
        value:
          "**Status**\n- Ready for review\n- URL: https://example.com/visible\n- Branch: `feat/log-rotation`\n- Owner: **Dispatch**\n- Marker: 🚀\n- Step: validate in sidebar\n- Step: keep lines wrapped\n\n```sh\npnpm run check\npnpm run test\npnpm run finalize:web\npnpm run test:e2e\nnpm run lint || true\n```",
      },
      { label: "Files", type: "filename", value: "one.ts,\ntwo.ts\nthree.ts" },
      { label: "Workspace root", type: "filename", value: workspaceRoot },
      {
        label: "Long file",
        type: "filename",
        value: `${workspaceRoot}/apps/web/src/components/app/pins-panel.tsx`,
      },
      { label: "Ports", type: "port", value: "3000 4000,\n5000" },
      {
        label: "API",
        type: "url",
        value: "http://127.0.0.1:8788/api/v1/agents?view=full&tab=pins",
      },
      {
        label: "Local URL",
        type: "url",
        value: "127.0.0.1:8788/api/v1/health",
      },
      { label: "Dev Web", type: "url", value: "  http://127.0.0.1:52804 \n" },
      {
        label: "PR",
        type: "pr",
        value: "https://github.com/selfcontained/dispatch/pull/123",
      },
      { label: "Review", type: "pr", value: "Review queue" },
      { label: "Agent ID", type: "code", value: "DISPATCH_AGENT_ID=agt_123" },
    ]);

    await loadApp(page);

    await openMediaSidebarForAgent(page, agent);

    const mediaSidebar = page.getByTestId("media-sidebar");
    await expect(mediaSidebar).toBeVisible();
    await mediaSidebar
      .getByRole("button", { name: "Pins" })
      .evaluate((el) => (el as HTMLButtonElement).click());

    const notesPre = mediaSidebar.locator("[data-pin-label='Notes'] pre");
    await expect(notesPre).toHaveText("line 1\n\n  line 2");

    const markdownPin = mediaSidebar.locator(
      "[data-pin-label='Summary'] [data-testid='markdown-pin-body']"
    );
    await expect(
      markdownPin.getByText("Status", { exact: true })
    ).toBeVisible();
    await expect(markdownPin.locator("strong").first()).toHaveText("Status");
    await expect(
      markdownPin.getByText("Ready for review", { exact: true })
    ).toBeVisible();
    await expect(markdownPin).toContainText("https://example.com/visible");
    await expect(
      markdownPin.getByText("feat/log-rotation", { exact: true })
    ).toBeVisible();
    await expect(markdownPin).toContainText("pnpm run check");
    await expect(markdownPin).toContainText("pnpm run test");
    await expect(markdownPin.getByRole("link")).toHaveCount(0);

    const scrollMetrics = await mediaSidebar
      .locator("[data-pin-label='Summary'] [data-testid='markdown-pin-scroll']")
      .evaluate((el) => {
        const container = el as HTMLElement;
        return {
          clientHeight: container.clientHeight,
          scrollHeight: container.scrollHeight,
        };
      });
    expect(scrollMetrics).not.toBeNull();
    expect(scrollMetrics!.scrollHeight).toBeGreaterThan(
      scrollMetrics!.clientHeight
    );

    await expect(
      mediaSidebar.getByText("one.ts", { exact: true })
    ).toBeVisible();
    await expect(
      mediaSidebar.getByText("two.ts", { exact: true })
    ).toBeVisible();
    await expect(
      mediaSidebar.getByText("three.ts", { exact: true })
    ).toBeVisible();
    const workspaceRootPin = mediaSidebar.locator(
      "[data-pin-label='Workspace root']"
    );
    await expect(workspaceRootPin).toContainText("./");
    await expect(
      workspaceRootPin.locator(`[title="${workspaceRoot}"]`)
    ).toHaveText("./");
    const longFilePin = mediaSidebar.locator("[data-pin-label='Long file']");
    await expect(longFilePin).toContainText("pins-panel.tsx");
    await expect(longFilePin).toContainText(
      "apps/web/src/components/app/pins-panel.tsx"
    );
    await expect(longFilePin).not.toContainText(workspaceRoot);
    await expect(longFilePin).not.toContainText("pins-panel.tsx/");
    await expect(mediaSidebar.getByText("3000", { exact: true })).toBeVisible();
    await expect(mediaSidebar.getByText("4000", { exact: true })).toBeVisible();
    await expect(mediaSidebar.getByText("5000", { exact: true })).toBeVisible();
    await expect(
      mediaSidebar.getByRole("link", {
        name: "http://127.0.0.1:8788/api/v1/agents?view=full&tab=pins",
      })
    ).toBeVisible();
    const localUrlPin = mediaSidebar.locator("[data-pin-label='Local URL']");
    await expect(
      localUrlPin.getByRole("link", { name: "127.0.0.1:8788/api/v1/health" })
    ).toHaveAttribute("href", "http://127.0.0.1:8788/api/v1/health");
    const devWebPin = mediaSidebar.locator("[data-pin-label='Dev Web']");
    await expect(
      devWebPin.getByRole("link", { name: "http://127.0.0.1:52804" })
    ).toBeVisible();
    await expect(
      mediaSidebar.getByRole("link", { name: "selfcontained/dispatch#123" })
    ).toBeVisible();
    await expect(
      mediaSidebar.getByText("Review queue", { exact: true })
    ).toBeVisible();
    await expect(
      mediaSidebar.getByText("DISPATCH_AGENT_ID=agt_123", { exact: true })
    ).toBeVisible();
  });

  test("renders shortcut pins as buttons that send their prompt to the agent", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-action-pins-${Date.now()}`,
      cwd: process.cwd(),
    });
    await setAgentPinsViaDB(agent.id, [
      {
        id: "pin_shortcut_plain",
        label: "Re-run E2E suite",
        type: "shortcut",
        value: "Re-run the full Playwright suite and report failures.",
      },
      {
        id: "pin_shortcut_captioned",
        label: "Work on sse-reconnect",
        type: "shortcut",
        variant: "primary",
        value: "work on sse-eventsource-reconnect",
        caption: "High priority · 3 files",
      },
      {
        id: "pin_shortcut_confirm",
        label: "Reset the dev database",
        type: "shortcut",
        variant: "destructive",
        confirm: true,
        value: "Drop and reseed the dev database.",
      },
    ]);

    await loadApp(page);
    await openMediaSidebarForAgent(page, agent);
    const mediaSidebar = page.getByTestId("media-sidebar");

    // Render details (label, caption, variants, disabled states) are covered by
    // pins-panel unit tests. What only E2E can prove is the wiring: a click in
    // the real sidebar reaches the run endpoint for the right pin.
    await mediaSidebar
      .getByRole("button", { name: "Reset the dev database" })
      .click();
    const dialog = page.getByTestId("pin-shortcut-confirm-dialog");
    await expect(dialog).toContainText("Drop and reseed the dev database.");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    const runResponse = page.waitForResponse((response) =>
      response
        .url()
        .includes(`/api/v1/agents/${agent.id}/pins/pin_shortcut_plain/run`)
    );
    await mediaSidebar
      .getByRole("button", { name: "Re-run E2E suite" })
      .click();
    expect((await runResponse).request().method()).toBe("POST");
  });
});
