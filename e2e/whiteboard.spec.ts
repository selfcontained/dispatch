import { expect, test } from "@playwright/test";
import { cleanupE2EAgents, createAgentViaAPI } from "./helpers";

const authHeader = {
  Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
};

async function waitForWhiteboard(
  page: import("@playwright/test").Page
): Promise<void> {
  await page.getByTestId("whiteboard-canvas").waitFor({ state: "visible" });
  // Excalidraw mounts its own canvases inside the host div.
  await page
    .locator('[data-testid="whiteboard-canvas"] canvas')
    .first()
    .waitFor({ state: "visible" });
}

test.describe("Whiteboard tab", () => {
  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("draws a rectangle that persists across reloads", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-whiteboard-${Date.now()}`,
    });

    await page.goto(`/agents/${agent.id}/whiteboard`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByTestId("agent-sidebar").waitFor({ state: "visible" });
    await expect(page.getByTestId("center-tab-whiteboard")).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await waitForWhiteboard(page);

    // Focus the canvas first — Excalidraw shortcuts only register once the
    // canvas has been clicked. Draw in the right half: with a shape tool
    // active, Excalidraw overlays a properties panel on the left side.
    const box = await page.getByTestId("whiteboard-canvas").boundingBox();
    if (!box) throw new Error("whiteboard canvas has no bounding box");
    const cx = box.x + box.width * 0.7;
    const cy = box.y + box.height * 0.6;
    await page.mouse.click(cx, cy);
    await page.keyboard.press("r");
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 160, cy + 90, { steps: 8 });
    await page.mouse.up();

    // Debounced save is 1s; poll the API until the scene lands.
    await expect
      .poll(
        async () => {
          const res = await request.get(
            `/api/v1/agents/${agent.id}/whiteboard`,
            { headers: authHeader }
          );
          const body = (await res.json()) as {
            version: number;
            scene: { elements: Array<{ type: string }> };
          };
          return body.scene.elements.filter((e) => e.type === "rectangle")
            .length;
        },
        { timeout: 10_000 }
      )
      .toBeGreaterThan(0);

    // Reload and confirm the board comes back from the server.
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForWhiteboard(page);
    const res = await request.get(`/api/v1/agents/${agent.id}/whiteboard`, {
      headers: authHeader,
    });
    const body = (await res.json()) as {
      version: number;
      scene: { elements: unknown[] };
    };
    expect(body.version).toBeGreaterThanOrEqual(1);
    expect(body.scene.elements.length).toBeGreaterThan(0);
  });

  test("tab bar switches between terminal and whiteboard without unmounting the board", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-whiteboard-tabs-${Date.now()}`,
    });

    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("terminal-pane").waitFor({ state: "visible" });

    await page.getByTestId("center-tab-whiteboard").click();
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}/whiteboard$`));
    await waitForWhiteboard(page);

    // Switch back to terminal: whiteboard stays mounted (hidden), so undo
    // history and zoom survive tab flips.
    await page.getByTestId("center-tab-terminal").click();
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`));
    await expect(page.getByTestId("whiteboard-canvas")).toBeHidden();
    await expect(page.getByTestId("whiteboard-canvas")).toBeAttached();

    await page.getByTestId("center-tab-whiteboard").click();
    await expect(page.getByTestId("whiteboard-canvas")).toBeVisible();
  });
});
