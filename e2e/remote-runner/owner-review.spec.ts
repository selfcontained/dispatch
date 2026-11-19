import { expect, test, type APIRequestContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { authHeaders, callMcpToolViaAPI, deleteAgentViaAPI } from "../helpers";
import {
  enrollViaUi,
  guest,
  lane,
  newSettledTurn,
  runnerRow,
  settledTurns,
  state,
} from "./harness";

/** One identical unpublished repo fixture for native and guest review. */
function seed(directory: string, marker: string) {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", directory, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.name", "Runner review fixture");
  git("config", "user.email", "fixture@localhost");
  mkdirSync(path.join(directory, ".agents/personas"), { recursive: true });
  writeFileSync(
    path.join(directory, ".agents/personas/fixture-review.md"),
    "Review the working checkout."
  );
  writeFileSync(
    path.join(directory, ".agents/personas/fixture-task.md"),
    "---\ntype: task\n---\nWork in the shared checkout."
  );
  writeFileSync(
    path.join(directory, ".agents/owners.json"),
    JSON.stringify({
      version: 1,
      rules: [{ paths: ["*.txt"], personas: ["code-review"] }],
    })
  );
  writeFileSync(
    path.join(directory, ".gitignore"),
    "provider-invocations\n.dispatch/\n.agents/personas/ignored-review.md\n"
  );
  mkdirSync(path.join(directory, ".dispatch"), { recursive: true });
  writeFileSync(
    path.join(directory, ".dispatch/tools.json"),
    JSON.stringify({
      tools: [
        {
          name: "fixture",
          description: marker,
          command: ["printf", "%s", marker],
        },
      ],
    })
  );
  writeFileSync(
    path.join(directory, ".agents/personas/ignored-review.md"),
    "---\nname: Ignored Review\n---\nReview the effective checkout."
  );

  git("add", ".");
  git("commit", "-m", "base");
  git("switch", "-c", "unpublished");
  writeFileSync(path.join(directory, "committed.txt"), "committed\n");
  git("add", ".");
  git("commit", "-m", "change");
  writeFileSync(path.join(directory, "review-marker.txt"), marker);
}

async function listTools(request: APIRequestContext, id: string) {
  const res = await request.post("/api/mcp/" + id, {
    headers: { Accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  const text = await res.text();
  const line = text.split("\n").find((line) => line.startsWith("data: "));
  expect(line, text).toBeDefined();
  return JSON.parse(line!.slice(6)).result.tools;
}

for (const placement of ["This Mac", "Linux runner"] as const) {
  test(`owner reviews share committed and uncommitted work on ${placement}`, async ({
    page,
    request,
  }, testInfo) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "dispatch-review-"));
    const marker = randomUUID();
    const agents: string[] = [];
    try {
      seed(tmp, marker);
      const remote = placement === "Linux runner";
      let cwd = tmp;
      if (remote) {
        const row = await runnerRow(request, "scratch");
        const runnerId =
          row?.id ?? (await enrollViaUi(page, request, "scratch"));
        cwd = `runner://${runnerId}/@session`;
      }
      const created = await request.post("/api/v1/agents", {
        headers: authHeaders(),
        data: {
          name: "Field review author",
          type: "claude",
          cwd,
          useWorktree: false,
          initialPrompt: "ready",
        },
      });
      expect(created.ok(), await created.text()).toBe(true);
      const author = (await created.json()).agent.id as string;
      agents.push(author);
      await page.goto("/agents/" + author, { waitUntil: "domcontentloaded" });
      await expect(settledTurns(page)).toHaveCount(1, { timeout: 45_000 });
      if (remote) {
        const container = state.runners.scratch.container;
        const directory = "/var/lib/runner/sessions/" + author;
        execFileSync("docker", ["cp", tmp + "/.", container + ":" + directory]);
        execFileSync("docker", [
          "exec",
          container,
          "chown",
          "-R",
          "1500:1500",
          directory,
        ]);
      }
      await expect
        .poll(() => listTools(request, author))
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "repo_fixture",
              description: marker,
            }),
          ])
        );
      const catalog = await callMcpToolViaAPI(
        request,
        author,
        "list_personas",
        {}
      );
      expect(catalog.result).toMatchObject({
        structuredContent: {
          personas: expect.arrayContaining([
            expect.objectContaining({ slug: "ignored-review" }),
          ]),
        },
      });
      const pickerCatalog = await request.get(
        "/api/v1/personas?agentId=" + author,
        {
          headers: authHeaders(),
        }
      );
      expect(pickerCatalog.ok(), await pickerCatalog.text()).toBe(true);
      expect(await pickerCatalog.json()).toMatchObject({
        codeowners: true,
        personas: expect.arrayContaining([
          expect.objectContaining({ slug: "ignored-review" }),
        ]),
      });
      if (!remote) {
        const desktopViewport = page.viewportSize()!;
        for (const [label, width] of [
          ["desktop", desktopViewport.width],
          ["mobile", 390],
        ] as const) {
          await page.setViewportSize({ width, height: desktopViewport.height });
          await page.goto(`/agents/${author}/changes`, {
            waitUntil: "domcontentloaded",
          });
          await page
            .getByTestId("changes-toolbar")
            .getByTestId("launch-reviewer-button")
            .click({ timeout: 15_000 });
          const dialog = page
            .getByRole("dialog")
            .filter({ has: page.getByTestId("launch-reviewer-codeowners") });
          await expect(
            dialog.getByText("Ignored Review", { exact: true })
          ).toBeVisible();
          await expect(
            dialog.getByTestId("launch-reviewer-codeowners")
          ).toBeEnabled();
          const path = testInfo.outputPath(`persona-picker-${label}.png`);
          await page.screenshot({ path });
          await testInfo.attach(`persona picker ${label}`, {
            path,
            contentType: "image/png",
          });
          await page.keyboard.press("Escape");
          await expect(dialog).toBeHidden();
        }
        await page.setViewportSize(desktopViewport);
      }
      // Leave both views mounted. Mutate outside the agent so ACP turn events
      // and a navigation-triggered refetch cannot account for the update.
      const files = await page.context().newPage();
      const changes = await page.context().newPage();
      const edit = (value: string) => {
        if (remote) {
          execFileSync(
            "docker",
            [
              "exec",
              "-i",
              "-u",
              "1500:1500",
              state.runners.scratch.container,
              "tee",
              "/var/lib/runner/sessions/" + author + "/review-marker.txt",
            ],
            { input: value, stdio: ["pipe", "ignore", "pipe"] }
          );
        } else writeFileSync(path.join(tmp, "review-marker.txt"), value);
      };
      try {
        await files.goto(
          "/agents/" + author + "/files?files.path=review-marker.txt",
          { waitUntil: "domcontentloaded" }
        );
        await changes.goto("/agents/" + author + "/changes", {
          waitUntil: "domcontentloaded",
        });
        const visibleOnBoth = async (value: string, timeout: number) => {
          await Promise.all(
            [files, changes].map((tab) =>
              expect(tab.getByText(value, { exact: false }).last()).toBeVisible(
                { timeout }
              )
            )
          );
        };
        await visibleOnBoth(marker, 20_000);
        const live = randomUUID();
        edit(live);
        await visibleOnBoth(live, 9_000);
        if (remote) {
          await lane("scratch", "block");
          try {
            await expect
              .poll(async () => (await runnerRow(request, "scratch"))?.status)
              .toBe("offline");
            await expect(
              files.getByText(/Showing the last loaded preview/)
            ).toBeVisible({ timeout: 12_000 });
            await expect(
              files.getByText(live, { exact: false }).last()
            ).toBeVisible();
            edit(marker);
          } finally {
            await lane("scratch", "allow");
          }
        } else edit(marker);
        await visibleOnBoth(marker, 12_000);
        for (const [label, tab] of [
          ["files", files],
          ["changes", changes],
        ] as const) {
          const screenshot = testInfo.outputPath(label + ".png");
          await tab.screenshot({ path: screenshot });
          await testInfo.attach(label, {
            path: screenshot,
            contentType: "image/png",
          });
        }
        if (remote) {
          await files.setViewportSize({ width: 390, height: 844 });
          await expect(
            files.getByText(marker, { exact: false }).last()
          ).toBeVisible();
          const screenshot = testInfo.outputPath("files-mobile.png");
          await files.screenshot({ path: screenshot });
          await testInfo.attach("Mobile runner file preview", {
            path: screenshot,
            contentType: "image/png",
          });
        }
      } finally {
        await files.close();
        await changes.close();
      }
      const review = await callMcpToolViaAPI(
        request,
        author,
        "launch_owner_reviews",
        {
          context: "Check the author's unpublished and dirty changes.",
          agentType: "claude",
        }
      );
      const plan = (
        review.result as {
          structuredContent: {
            owners: { persona: string; files: string[] }[];
            failures: unknown[];
            launched: { agentId: string }[];
          };
        }
      ).structuredContent;
      expect(plan.failures).toEqual([]);
      expect(plan.owners).toEqual([
        {
          persona: "code-review",
          files: ["committed.txt", "review-marker.txt"],
        },
      ]);
      expect(plan.launched).toHaveLength(1);
      const reviewer = plan.launched[0]!.agentId;
      agents.push(reviewer);
      await page.goto("/agents/" + reviewer, { waitUntil: "domcontentloaded" });
      await expect(settledTurns(page)).toHaveCount(1, { timeout: 45_000 });
      await newSettledTurn(
        page,
        "proof-reviewed-checkout",
        "Checkout marker " + marker
      );
      const screenshot = testInfo.outputPath("reviewer-checkout.png");
      await page.screenshot({ path: screenshot });
      await testInfo.attach("reviewer in author checkout", {
        path: screenshot,
        contentType: "image/png",
      });
      const nested = await callMcpToolViaAPI(
        request,
        reviewer,
        "launch_agent",
        {
          persona: "ignored-review",
          name: "Nested checkout reviewer",
          type: "claude",
          prompt: "Review the same checkout.",
        }
      );
      const nestedId = (
        nested.result as { structuredContent: { agentId: string } }
      ).structuredContent.agentId;
      agents.push(nestedId);
      await page.goto("/agents/" + nestedId, { waitUntil: "domcontentloaded" });
      await expect(settledTurns(page)).toHaveCount(1, { timeout: 45_000 });
      expect(await listTools(request, nestedId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "repo_fixture",
            description: marker,
          }),
        ])
      );
      await deleteAgentViaAPI(request, nestedId);
      agents.pop();
      await deleteAgentViaAPI(request, reviewer);
      agents.pop();
      await page.goto("/agents/" + author, { waitUntil: "domcontentloaded" });
      await expect(settledTurns(page)).toHaveCount(1, { timeout: 45_000 });
      await newSettledTurn(
        page,
        "proof-reviewed-checkout",
        "Checkout marker " + marker
      );
      for (const persona of [undefined, "fixture-review", "fixture-task"]) {
        const reply = await callMcpToolViaAPI(request, author, "launch_agent", {
          prompt: "proof-reviewed-checkout",
          name: persona ?? "Ordinary child",
          ...(persona ? { persona } : {}),
          type: "claude",
        });
        const { agentId } = (
          reply.result as { structuredContent: { agentId: string } }
        ).structuredContent;
        agents.push(agentId);
        await page.goto("/agents/" + agentId, {
          waitUntil: "domcontentloaded",
        });
        // Review personas receive a separate kickoff. Ask explicitly in both sessions.
        await expect(settledTurns(page)).toHaveCount(1, { timeout: 45000 });
        await newSettledTurn(
          page,
          "proof-reviewed-checkout",
          "Checkout marker " + marker
        );
        await page.screenshot({
          path: testInfo.outputPath((persona ?? "ordinary-child") + ".png"),
        });
        await deleteAgentViaAPI(request, agentId);
        agents.pop();
      }
    } finally {
      for (const id of agents.reverse()) await deleteAgentViaAPI(request, id);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test("identical runner paths yield separate tool catalogs", async ({
  page,
  request,
}) => {
  const agents: string[] = [];
  try {
    expect(state.runners.alpha.workspaceDir).toBe(
      state.runners.beta.workspaceDir
    );
    for (const name of ["alpha", "beta"] as const) {
      const runner =
        (await runnerRow(request, name))?.id ??
        (await enrollViaUi(page, request, name));
      const directory = state.runners[name].workspaceDir;
      const writeManifest = (description: string) => {
        const json = JSON.stringify({
          tools: [{ name: "same_path", description, command: ["true"] }],
        });
        guest(
          name,
          `mkdir -p "${directory}/.dispatch" && printf '%s' '${json}' > "${directory}/.dispatch/tools.json"`
        );
      };
      writeManifest(name);
      const res = await request.post("/api/v1/agents", {
        headers: authHeaders(),
        data: {
          name: `Catalog ${name}`,
          type: "claude",
          useWorktree: false,
          cwd: `runner://${runner}/${state.workspace}`,
          initialPrompt: "ready",
        },
      });
      expect(res.ok(), await res.text()).toBe(true);
      const id = (await res.json()).agent.id as string;
      agents.push(id);
      const listed = () => listTools(request, id);
      const matching = (description: string) =>
        expect.arrayContaining([
          expect.objectContaining({ name: "repo_same_path", description }),
        ]);
      await expect.poll(listed).toEqual(matching(name));
      writeManifest(`${name} edited`);
      await expect.poll(listed).toEqual(matching(`${name} edited`));
      guest(name, `rm "${directory}/.dispatch/tools.json"`);
      await expect.poll(listed).not.toEqual(matching(`${name} edited`));
    }
  } finally {
    for (const id of agents) await deleteAgentViaAPI(request, id);
  }
});
