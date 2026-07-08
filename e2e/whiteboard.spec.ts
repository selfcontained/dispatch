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

  test("agent whiteboard_update lands on the board and lights the tab dot", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-whiteboard-agent-${Date.now()}`,
    });

    // Mount the whiteboard once, then watch from the terminal tab.
    await page.goto(`/agents/${agent.id}/whiteboard`, {
      waitUntil: "domcontentloaded",
    });
    await waitForWhiteboard(page);
    await page.getByTestId("center-tab-terminal").click();
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`));

    // Draw through the real MCP tool, exactly as an agent would. The scoped
    // MCP route accepts tokenless local calls; the server bearer token is
    // NOT a valid agent-scoped MCP token and would 403.
    const mcpRes = await request.post(`/api/mcp/${agent.id}`, {
      headers: {
        accept: "application/json, text/event-stream",
      },
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "whiteboard_update",
          arguments: {
            ops: [
              {
                op: "add",
                type: "rect",
                id: "api",
                x: 100,
                y: 100,
                w: 160,
                h: 70,
                label: "api",
              },
              {
                op: "add",
                type: "ellipse",
                id: "db",
                x: 400,
                y: 300,
                w: 140,
                h: 80,
                label: "db",
                fill: "violet",
              },
              {
                op: "add",
                type: "arrow",
                id: "flow",
                from: "api",
                to: "db",
                label: "reads",
                elbow: true,
              },
              {
                op: "add",
                type: "arrow",
                id: "retry",
                from: "db",
                to: "api",
                style: "dashed",
                startHead: "dot",
                endHead: "triangle",
                via: [[150, 400]],
              },
            ],
          },
        },
      },
    });
    expect(mcpRes.ok()).toBe(true);
    const dataLine = (await mcpRes.text())
      .split("\n")
      .find((l) => l.startsWith("data: "));
    expect(dataLine).toBeDefined();
    const rpc = JSON.parse(dataLine!.slice(6)) as {
      result: {
        structuredContent: {
          ok: boolean;
          created: Array<{ id: string }>;
          errors: string[];
        };
      };
    };
    expect(rpc.result.structuredContent.ok).toBe(true);
    expect(rpc.result.structuredContent.created.map((c) => c.id)).toEqual([
      "api",
      "db",
      "flow",
      "retry",
    ]);

    // The SSE event lights the "agent drew" dot while we're on Terminal…
    await expect(page.getByTestId("whiteboard-agent-drew-dot")).toBeVisible({
      timeout: 10_000,
    });

    // …and the scene now holds the bound diagram (shapes + labels + arrow).
    const res = await request.get(`/api/v1/agents/${agent.id}/whiteboard`, {
      headers: authHeader,
    });
    const body = (await res.json()) as {
      scene: {
        elements: Array<{
          id: string;
          type: string;
          points?: number[][];
          strokeStyle?: string;
          backgroundColor?: string;
          startArrowhead?: string | null;
          endArrowhead?: string | null;
          startBinding?: { elementId: string } | null;
          endBinding?: { elementId: string } | null;
        }>;
      };
    };
    const arrow = body.scene.elements.find((e) => e.id === "flow");
    expect(arrow?.startBinding?.elementId).toBe("api");
    expect(arrow?.endBinding?.elementId).toBe("db");
    // elbow: true routes with right-angle bends, not a single segment.
    expect(arrow?.points?.length).toBeGreaterThan(2);
    const retry = body.scene.elements.find((e) => e.id === "retry");
    expect(retry?.strokeStyle).toBe("dashed");
    expect(retry?.startArrowhead).toBe("dot");
    expect(retry?.endArrowhead).toBe("triangle");
    expect(retry?.points?.length).toBe(3); // via bend baked in
    const db = body.scene.elements.find((e) => e.id === "db");
    expect(db?.backgroundColor).toBe("#e5dbff");
    expect(body.scene.elements.filter((e) => e.type === "text").length).toBe(3);

    // Visiting the whiteboard clears the dot.
    await page.getByTestId("center-tab-whiteboard").click();
    await expect(page.getByTestId("whiteboard-agent-drew-dot")).toHaveCount(0);
  });
});
