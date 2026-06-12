import { expect, test, type Page } from "@playwright/test";

import { cleanupE2EAgents, createAgentViaAPI, loadApp } from "./helpers";

// Dispatch a synthetic drag event carrying a file onto the terminal host.
// We add a real File so dataTransfer.types includes "Files", which is what the
// terminal's drag handlers gate on.
async function dispatchDragEvent(
  page: Page,
  type: "dragenter" | "dragover" | "dragleave" | "drop",
  file: { name: string; mime: string }
): Promise<void> {
  await page.evaluate(
    ({ eventType, file }) => {
      const host =
        document.querySelector('[data-testid="terminal-pane"] .xterm') ??
        document.querySelector('[data-testid="terminal-pane"]');
      if (!host) throw new Error("terminal host not found");
      const dt = new DataTransfer();
      dt.items.add(new File(["fake-bytes"], file.name, { type: file.mime }));
      host.dispatchEvent(
        new DragEvent(eventType, {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        })
      );
    },
    { eventType: type, file }
  );
}

// Dispatch a synthetic Cmd/Ctrl+V paste of an image onto the terminal host.
async function dispatchPaste(
  page: Page,
  file: { name: string; mime: string }
): Promise<void> {
  await page.evaluate(
    ({ file }) => {
      const host =
        document.querySelector('[data-testid="terminal-pane"] .xterm') ??
        document.querySelector('[data-testid="terminal-pane"]');
      if (!host) throw new Error("terminal host not found");
      const dt = new DataTransfer();
      dt.items.add(new File(["fake-bytes"], file.name, { type: file.mime }));
      host.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        })
      );
    },
    { file }
  );
}

const TXT = { name: "notes.txt", mime: "text/plain" };
const IMG = { name: "shot.png", mime: "image/png" };

test.describe("Terminal drag-and-drop file upload", () => {
  test.afterAll(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("shows a shiny drop overlay and uploads a non-image file with a [File #N] label", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-dragdrop-${Date.now()}`,
    });

    await loadApp(page);
    await page.getByTestId(`agent-row-${agent.id}`).click();
    await expect(page.getByTestId("terminal-pane")).toBeVisible();

    const overlay = page.getByTestId("terminal-drop-overlay");
    await expect(overlay).toBeHidden();

    // Dragging files over the terminal reveals the overlay.
    await dispatchDragEvent(page, "dragenter", TXT);
    await dispatchDragEvent(page, "dragover", TXT);
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText("Drop files to upload");
    await page.screenshot({ path: "/tmp/terminal-drop-overlay.png" });

    // Leaving the terminal hides the overlay again.
    await dispatchDragEvent(page, "dragleave", TXT);
    await expect(overlay).toBeHidden();

    // Slow the media upload so the uploading indicator is observable.
    await page.route(`**/api/v1/agents/${agent.id}/media`, async (route) => {
      await new Promise((r) => setTimeout(r, 800));
      await route.continue();
    });

    const uploadPromise = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        req.url().includes(`/api/v1/agents/${agent.id}/media`)
    );
    await dispatchDragEvent(page, "dragover", TXT);
    await dispatchDragEvent(page, "drop", TXT);

    // Non-image files go to the media endpoint, and the uploading indicator
    // (shared ActivityBars loader) shows while the slowed request is in flight.
    await expect(page.getByTestId("terminal-uploading-overlay")).toBeVisible();
    const uploadReq = await uploadPromise;
    expect(uploadReq.url()).toContain(`/api/v1/agents/${agent.id}/media`);
    await expect(overlay).toBeHidden();
    await expect(page.getByTestId("terminal-uploading-overlay")).toBeHidden();

    // The resulting `[File #N] <path>` prompt insertion is sent over the
    // terminal WebSocket via sendTerminalInput — only observable against a live
    // tmux session, so it's validated on the deployed VM rather than here
    // (the inert e2e stack has no live terminal to echo it).
  });

  test("uploads images to the media endpoint too (same path as other files)", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-dragdrop-img-${Date.now()}`,
    });

    await loadApp(page);
    await page.getByTestId(`agent-row-${agent.id}`).click();
    await expect(page.getByTestId("terminal-pane")).toBeVisible();

    // Images are handled like any other file: uploaded to the media store and
    // referenced in the prompt — they do NOT use the clipboard endpoint.
    let mediaSeen = false;
    let clipboardSeen = false;
    page.on("request", (req) => {
      if (req.method() !== "POST") return;
      if (req.url().includes(`/api/v1/agents/${agent.id}/media`)) {
        mediaSeen = true;
      }
      if (req.url().includes("/api/v1/clipboard/image")) clipboardSeen = true;
    });

    // Re-attempt the drop until it fires the upload — the upload no-ops until
    // the terminal has connected (connectedAgentId set), which can lag the
    // pane becoming visible.
    await expect
      .poll(
        async () => {
          await dispatchDragEvent(page, "dragover", IMG);
          await dispatchDragEvent(page, "drop", IMG);
          return mediaSeen;
        },
        { timeout: 15_000, intervals: [200, 300, 500] }
      )
      .toBe(true);

    expect(clipboardSeen).toBe(false);
  });

  test("pastes images via the media endpoint", async ({ page, request }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-paste-${Date.now()}`,
    });

    let mediaSeen = false;
    page.on("request", (req) => {
      if (
        req.method() === "POST" &&
        req.url().includes(`/api/v1/agents/${agent.id}/media`)
      ) {
        mediaSeen = true;
      }
    });

    await loadApp(page);
    await page.getByTestId(`agent-row-${agent.id}`).click();
    await expect(page.getByTestId("terminal-pane")).toBeVisible();

    await expect
      .poll(
        async () => {
          await dispatchPaste(page, IMG);
          return mediaSeen;
        },
        { timeout: 15_000, intervals: [200, 300, 500] }
      )
      .toBe(true);
  });
});
