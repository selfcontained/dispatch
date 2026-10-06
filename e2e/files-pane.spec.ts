import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanupE2EAgents, createAgentViaAPI } from "./helpers";

test("Files browses lazily, refreshes manually and opens beside Agent", async ({
  page,
  request,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), "dispatch-explorer-e2e-"));
  try {
    await promisify(execFile)("git", ["init", root]);
    await writeFile(path.join(root, ".gitignore"), "node_modules/\n");
    await mkdir(path.join(root, "node_modules"));
    await mkdir(path.join(root, "source"));
    await writeFile(
      path.join(root, "source", "hello.ts"),
      (
        "export const greeting = 'hello explorer " +
        "long line ".repeat(25) +
        "';\n"
      ).repeat(450)
    );
    const agent = await createAgentViaAPI(request, {
      cwd: root,
      name: `e2e-files-${Date.now()}`,
    });
    let reads = 0;
    page.on("request", (r) => {
      if (r.url().includes(`/agents/${agent.id}/workspace?`)) reads++;
    });
    await page.goto(`/agents/${agent.id}/files`, {
      waitUntil: "domcontentloaded",
    });
    const pane = page.getByTestId("files-pane");
    await expect(
      pane.getByRole("treeitem", { name: "source", exact: true })
    ).toBeVisible();
    await expect(
      pane.getByRole("treeitem", { name: "node_modules", exact: true })
    ).toHaveCount(0);
    await pane.getByRole("textbox", { name: "Find files" }).fill("hello.ts");
    await pane
      .getByRole("treeitem", { name: "hello.ts source/hello.ts", exact: true })
      .click();
    await pane.getByRole("textbox", { name: "Find files" }).fill("");
    await pane.getByRole("treeitem", { name: "source", exact: true }).click();
    await pane.getByRole("treeitem", { name: "hello.ts", exact: true }).click();
    await expect(pane.getByTestId("file-text-preview")).toContainText(
      "hello explorer"
    );
    await expect(
      pane.getByTestId("file-text-preview").locator(".hljs-keyword").first()
    ).toBeVisible();
    await expect(
      pane.getByRole("combobox", { name: "Code theme" })
    ).toHaveCount(0);
    await expect(
      pane.getByRole("button", { name: "Copy", exact: true })
    ).toHaveCount(1);
    await expect(
      pane.getByRole("button", { name: "Copy relative path" })
    ).toHaveCount(0);
    const copyButton = pane.getByRole("button", { name: "Copy", exact: true });
    await expect(copyButton).toHaveText("");
    await copyButton.click();
    await expect(
      pane.getByRole("button", { name: "Copied", exact: true })
    ).toHaveAttribute("data-copied", "true");
    await expect(copyButton).toHaveAttribute("data-copied", "false");
    const downloadPromise = page.waitForEvent("download");
    await pane.getByRole("link", { name: "Download", exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("hello.ts");
    const scroller = pane.getByTestId("file-text-preview");
    const horizontal = pane.getByTestId("file-code-scroll");
    const gutter = pane.getByTestId("file-line-number").first();
    const code = pane.getByTestId("file-source-line").first();
    const gutterBefore = await gutter.boundingBox();
    const codeBefore = await code.boundingBox();
    const control = pane.getByTestId("file-horizontal-control");
    await expect(control).toBeVisible();
    const thumb = control.locator(
      '[data-orientation="horizontal"] > [data-state]'
    );
    const thumbBox = (await thumb.boundingBox())!;
    const controlBox = (await control.boundingBox())!;
    const viewportBox = (await scroller.boundingBox())!;
    expect(controlBox.y).toBeGreaterThanOrEqual(viewportBox.y);
    expect(controlBox.y + controlBox.height).toBeLessThanOrEqual(
      (await pane.boundingBox())!.y + (await pane.boundingBox())!.height + 1
    );
    await page.mouse.move(
      thumbBox.x + thumbBox.width / 2,
      thumbBox.y + thumbBox.height / 2
    );
    await page.mouse.down();
    await page.mouse.move(
      thumbBox.x + thumbBox.width / 2 + 180,
      thumbBox.y + thumbBox.height / 2,
      { steps: 8 }
    );
    await page.mouse.up();
    await expect
      .poll(() => horizontal.evaluate((el) => el.scrollLeft))
      .toBeGreaterThan(300);
    await scroller.evaluate((element) => {
      element.scrollTop = 96;
    });
    expect(
      await horizontal.evaluate((element) =>
        element.contains(document.querySelector('[data-testid="file-gutter"]'))
      )
    ).toBe(false);
    expect(
      await scroller.evaluate(
        (element) => element.scrollWidth <= element.clientWidth
      )
    ).toBe(true);
    await expect
      .poll(() =>
        gutter.evaluate((element) => element.getBoundingClientRect().x)
      )
      .toBe(gutterBefore!.x);
    expect((await code.boundingBox())!.x).toBeLessThan(codeBefore!.x - 300);
    expect((await gutter.boundingBox())!.y).toBe((await code.boundingBox())!.y);
    await horizontal.evaluate((element) => {
      element.scrollLeft = 0;
    });
    await scroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(
      pane.getByRole("button", { name: "Next", exact: true })
    ).toHaveCount(0);
    await scroller.evaluate((element) => {
      element.scrollTop = 240 * 24;
    });
    await expect(
      pane.getByTestId("file-line-number").filter({ hasText: /^250$/ })
    ).toBeVisible();
    expect(await pane.getByTestId("file-source-line").count()).toBeLessThan(
      100
    );
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(pane.getByTestId("file-line-number").last()).toHaveText("451");
    await scroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(pane.getByTestId("file-line-number").first()).toHaveText("1");
    const settledReads = reads;
    await page.waitForTimeout(1200);
    expect(reads).toBe(settledReads);
    await writeFile(path.join(root, "source", "hello.ts"), "updated on disk");
    await pane
      .getByRole("button", { name: "Refresh files and preview" })
      .click();
    await expect(pane.getByTestId("file-text-preview")).toContainText(
      "updated on disk"
    );
    await pane.getByRole("button", { name: "Open beside Agent" }).click();
    await expect(page.getByTestId("agent-pane")).toBeVisible();
    await expect(pane).toBeVisible();
    await page.getByTestId("unsplit-button").click();
    await expect(pane).toBeVisible();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(pane.getByTestId("file-text-preview")).toContainText(
      "updated on disk"
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme-mode", "light")
    );
    await expect(scroller).toHaveCSS("background-color", "rgb(250, 250, 250)");
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme-mode", "dark")
    );
    await expect(scroller).toHaveCSS("background-color", "rgb(16, 17, 20)");
    await pane.getByRole("button", { name: "Browse files" }).click();
    await expect(
      pane.getByRole("treeitem", { name: "source", exact: true })
    ).toBeVisible();
    await expect(
      pane.getByRole("treeitem", { name: "source", exact: true })
    ).toHaveAttribute("aria-expanded", "true");
    await pane.getByRole("treeitem", { name: "hello.ts", exact: true }).click();
    await expect(pane.getByTestId("file-text-preview")).toContainText(
      "updated on disk"
    );
  } finally {
    await cleanupE2EAgents(request);
    await rm(root, { recursive: true, force: true });
  }
});

test("Files keyboard navigation reaches virtual rows and restores browsing state", async ({
  page,
  request,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), "dispatch-files-keyboard-"));
  try {
    await mkdir(path.join(root, "source"));
    await Promise.all(
      Array.from({ length: 300 }, (_, i) =>
        writeFile(
          path.join(root, "source", `file-${String(i).padStart(3, "0")}.ts`),
          `export const index = ${i};`
        )
      )
    );
    const agent = await createAgentViaAPI(request, {
      cwd: root,
      name: `e2e-files-keys-${Date.now()}`,
    });
    await page.goto(`/agents/${agent.id}/files`, {
      waitUntil: "domcontentloaded",
    });
    const pane = page.getByTestId("files-pane");
    const tree = pane.getByRole("tree", { name: "Workspace files" });
    await expect(
      pane.getByRole("treeitem", { name: "source", exact: true })
    ).toBeVisible();
    await tree.focus();
    await tree.press("ArrowRight");
    await expect(
      pane.getByRole("treeitem", { name: "file-000.ts", exact: true })
    ).toBeVisible();
    await tree.press("End");
    const last = pane.getByRole("treeitem", {
      name: "file-299.ts",
      exact: true,
    });
    await expect(last).toBeVisible();
    await expect(tree).toHaveAttribute(
      "aria-activedescendant",
      (await last.getAttribute("id")) ?? ""
    );
    expect(await pane.getByRole("treeitem").count()).toBeLessThan(60);
    await tree.press("Enter");
    await expect(pane.getByTestId("file-text-preview")).toContainText(
      "index = 299"
    );
    const top = await tree.evaluate((el) => el.scrollTop);
    await page.getByRole("tab", { name: "Agent", exact: true }).click();
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await expect(last).toBeVisible();
    await expect.poll(() => tree.evaluate((el) => el.scrollTop)).toBe(top);
    await tree.focus();
    await tree.press("Home");
    await tree.press("ArrowLeft");
    await expect(
      pane.getByRole("treeitem", { name: "source", exact: true })
    ).toHaveAttribute("aria-expanded", "false");
    await pane.getByRole("textbox", { name: "Find files" }).fill("file-299");
    await expect(
      pane.getByRole("treeitem", {
        name: "file-299.ts source/file-299.ts",
        exact: true,
      })
    ).toBeVisible();
    await page.getByRole("tab", { name: "Agent", exact: true }).click();
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await expect(pane.getByRole("textbox", { name: "Find files" })).toHaveValue(
      "file-299"
    );
    await expect(
      pane.getByRole("treeitem", {
        name: "file-299.ts source/file-299.ts",
        exact: true,
      })
    ).toBeVisible();
  } finally {
    await cleanupE2EAgents(request);
    await rm(root, { recursive: true, force: true });
  }
});
