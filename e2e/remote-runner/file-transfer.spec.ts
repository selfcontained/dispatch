import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { authHeaders, cleanupE2EAgents, trackAgent } from "../helpers";
import { chat, enrollViaUi, state } from "./harness";

const png = readFileSync(
  new URL("../../apps/web/public/icons/teal/pwa-192.png", import.meta.url)
);
const image = {
  name: "transfer-input.png",
  mimeType: "image/png",
  buffer: png,
};

test.afterAll(async ({ request }) => cleanupE2EAgents(request));

test("file transfer keeps local and remote posted bytes after archive", async ({
  browser,
  page,
  request,
}, testInfo) => {
  const runnerId = await enrollViaUi(page, request, "alpha");
  for (const [lane, cwd, viewport] of [
    ["local", "/tmp", { width: 1440, height: 900 }],
    [
      "remote",
      `runner://${runnerId}/${state.workspace}`,
      { width: 390, height: 844 },
    ],
  ] as const) {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 2,
    });
    try {
      const session = await context.newPage();
      const launch = await request.post("/api/v1/agents", {
        headers: authHeaders(),
        multipart: {
          name: `e2e-transfer-${lane}`,
          cwd,
          type: "codex",
          useWorktree: "false",
          initialPrompt: "proof-file-transfer startup",
          startupFiles: image,
        },
      });
      expect(launch.status(), await launch.text()).toBe(201);
      const {
        agent: { id },
      } = await launch.json();
      trackAgent(id);
      const filesUrl = `/api/v1/agents/${id}/files`;
      const posted = async () => {
        const response = await request.get(filesUrl, {
          headers: authHeaders(),
        });
        return (await response.json()).files.filter((file: { name: string }) =>
          file.name.startsWith("transfer-output-")
        );
      };
      const turnMessage = "Read the uploaded image and posted the result.";
      await session.goto(`/agents/${id}`, { waitUntil: "domcontentloaded" });
      await expect(session.getByText(turnMessage, { exact: true })).toHaveCount(
        1,
        { timeout: 45_000 }
      );
      await expect.poll(async () => (await posted()).length).toBe(1);

      const fileInput = session.getByTestId("chat-composer-file-input");
      await expect(session.getByTestId("chat-composer-input")).toBeEnabled();
      await fileInput.setInputFiles(image);
      await expect(
        session.getByTestId("chat-composer-attachments")
      ).toBeVisible();
      await chat(session, "proof-file-transfer follow-up");
      await expect(session.getByText(turnMessage, { exact: true })).toHaveCount(
        2,
        { timeout: 45_000 }
      );
      const copies = await posted();
      expect(copies).toHaveLength(2);
      const retained = copies[0].url;

      const shot = (phase: string) => {
        const name = `runner-transfer-${lane}-${phase}.png`;
        const directory = process.env.RUNNER_TRANSFER_EVIDENCE;
        return session
          .screenshot({
            path: directory
              ? path.join(directory, name)
              : testInfo.outputPath(name),
          })
          .then((body) =>
            testInfo.attach(name, { body, contentType: "image/png" })
          );
      };
      await shot("posted");
      const archive = await request.delete(`/api/v1/agents/${id}`, {
        headers: authHeaders(),
      });
      expect(archive.status(), await archive.text()).toBe(202);
      await expect
        .poll(
          async () =>
            (
              await request.get(`/api/v1/agents/${id}`, {
                headers: authHeaders(),
              })
            ).status(),
          { timeout: 45_000 }
        )
        .toBe(404);
      const opened = await session.goto(retained, {
        waitUntil: "domcontentloaded",
      });
      expect(opened?.ok()).toBe(true);
      expect(await opened!.body()).toEqual(png);
      await expect
        .poll(() =>
          session
            .locator("img")
            .evaluate((image: HTMLImageElement) => image.naturalWidth)
        )
        .toBe(192);
      await shot("retained");
    } finally {
      await context.close();
    }
  }
});
