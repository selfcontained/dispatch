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

  test("shows a drop overlay, uploads a file, and creates a media entry", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-dragdrop-${Date.now()}`,
    });

    await loadApp(page);
    const tokenReady = page.waitForResponse(
      (r) =>
        r.url().includes(`/agents/${agent.id}/terminal/token`) &&
        r.status() === 200,
      { timeout: 30_000 }
    );
    await page.getByTestId(`agent-row-${agent.id}`).click();
    await expect(page.getByTestId("terminal-pane")).toBeVisible();
    await tokenReady;
    await expect(page.getByTestId("terminal-connected-state")).toBeAttached({
      timeout: 5_000,
    });

    const overlay = page.getByTestId("terminal-drop-overlay");
    await expect(overlay).toBeHidden();

    // Dragging files over the terminal reveals the overlay.
    await dispatchDragEvent(page, "dragenter", TXT);
    await dispatchDragEvent(page, "dragover", TXT);
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText("Drop files to upload");

    // Leaving the terminal hides the overlay again.
    await dispatchDragEvent(page, "dragleave", TXT);
    await expect(overlay).toBeHidden();

    // The uploading overlay mounts while the request is in flight. Listen for
    // its console log so we can confirm it rendered without artificial delays.
    let overlayMounted = false;
    page.on("console", (msg) => {
      if (msg.text().includes("[dispatch:uploading-overlay] mounted"))
        overlayMounted = true;
    });

    // Wait for the upload response (not just the request) so the DB write
    // has committed before we query the media list.
    let uploadSent = false;
    let uploadDone = false;
    page.on("request", (req) => {
      if (
        req.method() === "POST" &&
        req.url().includes(`/api/v1/agents/${agent.id}/media`)
      )
        uploadSent = true;
    });
    page.on("response", (res) => {
      if (
        res.request().method() === "POST" &&
        res.url().includes(`/api/v1/agents/${agent.id}/media`) &&
        res.status() === 201
      )
        uploadDone = true;
    });

    await expect
      .poll(
        async () => {
          if (!uploadSent) {
            await dispatchDragEvent(page, "dragover", TXT);
            await dispatchDragEvent(page, "drop", TXT);
          }
          return uploadDone;
        },
        { timeout: 30_000, intervals: [200, 300, 500] }
      )
      .toBe(true);

    expect(overlayMounted).toBe(true);

    // The upload created a media entry in the DB.
    const mediaRes = await request.get(`/api/v1/agents/${agent.id}/media`);
    const mediaList = (await mediaRes.json()) as {
      files: { name: string; source: string; size: number }[];
    };
    const entry = mediaList.files.find((f) => f.name.includes("notes"));
    expect(entry).toBeDefined();
    expect(entry!.source).toBe("user");
    expect(entry!.size).toBeGreaterThan(0);
  });

  test("dropping an image creates a media entry and never hits the clipboard endpoint", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-dragdrop-img-${Date.now()}`,
    });

    await loadApp(page);
    const tokenReady = page.waitForResponse(
      (r) =>
        r.url().includes(`/agents/${agent.id}/terminal/token`) &&
        r.status() === 200,
      { timeout: 30_000 }
    );
    await page.getByTestId(`agent-row-${agent.id}`).click();
    await expect(page.getByTestId("terminal-pane")).toBeVisible();
    await tokenReady;
    await expect(page.getByTestId("terminal-connected-state")).toBeAttached({
      timeout: 5_000,
    });

    let uploadSent = false;
    let uploadDone = false;
    let clipboardSeen = false;
    page.on("request", (req) => {
      if (
        req.method() === "POST" &&
        req.url().includes(`/api/v1/agents/${agent.id}/media`)
      )
        uploadSent = true;
      if (
        req.method() === "POST" &&
        req.url().includes("/api/v1/clipboard/image")
      )
        clipboardSeen = true;
    });
    page.on("response", (res) => {
      if (
        res.request().method() === "POST" &&
        res.url().includes(`/api/v1/agents/${agent.id}/media`) &&
        res.status() === 201
      )
        uploadDone = true;
    });

    await expect
      .poll(
        async () => {
          if (!uploadSent) {
            await dispatchDragEvent(page, "dragover", IMG);
            await dispatchDragEvent(page, "drop", IMG);
          }
          return uploadDone;
        },
        { timeout: 30_000, intervals: [200, 300, 500] }
      )
      .toBe(true);

    expect(clipboardSeen).toBe(false);

    // A media entry was persisted for the image.
    const mediaRes = await request.get(`/api/v1/agents/${agent.id}/media`);
    const mediaList = (await mediaRes.json()) as {
      files: { name: string; source: string; size: number }[];
    };
    const entry = mediaList.files.find((f) => f.name.includes("shot"));
    expect(entry).toBeDefined();
    expect(entry!.size).toBeGreaterThan(0);
  });

  test("pasting an image creates a media entry via the media endpoint", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-agent-paste-${Date.now()}`,
    });

    let uploadSent = false;
    let uploadDone = false;
    page.on("request", (req) => {
      if (
        req.method() === "POST" &&
        req.url().includes(`/api/v1/agents/${agent.id}/media`)
      )
        uploadSent = true;
    });
    page.on("response", (res) => {
      if (
        res.request().method() === "POST" &&
        res.url().includes(`/api/v1/agents/${agent.id}/media`) &&
        res.status() === 201
      )
        uploadDone = true;
    });

    await loadApp(page);
    const tokenReady = page.waitForResponse(
      (r) =>
        r.url().includes(`/agents/${agent.id}/terminal/token`) &&
        r.status() === 200,
      { timeout: 30_000 }
    );
    await page.getByTestId(`agent-row-${agent.id}`).click();
    await expect(page.getByTestId("terminal-pane")).toBeVisible();
    await tokenReady;
    await expect(page.getByTestId("terminal-connected-state")).toBeAttached({
      timeout: 5_000,
    });

    await expect
      .poll(
        async () => {
          if (!uploadSent) {
            await dispatchPaste(page, IMG);
          }
          return uploadDone;
        },
        { timeout: 30_000, intervals: [200, 300, 500] }
      )
      .toBe(true);

    // A media entry was persisted for the pasted image.
    const mediaRes = await request.get(`/api/v1/agents/${agent.id}/media`);
    const mediaList = (await mediaRes.json()) as {
      files: { name: string; source: string; size: number }[];
    };
    expect(mediaList.files.length).toBeGreaterThanOrEqual(1);
    const entry = mediaList.files[0];
    expect(entry.name).toMatch(/\.png$/);
    expect(entry.source).toBe("user");
    expect(entry.size).toBeGreaterThan(0);
  });
});
