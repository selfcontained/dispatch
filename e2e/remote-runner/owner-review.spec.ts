import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { authHeaders, callMcpToolViaAPI, deleteAgentViaAPI } from "../helpers";
import {
  enrollViaUi,
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
  mkdirSync(path.join(directory, ".agents"));
  writeFileSync(
    path.join(directory, ".agents/owners.json"),
    JSON.stringify({
      version: 1,
      rules: [{ paths: ["*.txt"], personas: ["code-review"] }],
    })
  );
  writeFileSync(path.join(directory, ".gitignore"), "provider-invocations\n");
  git("add", ".");
  git("commit", "-m", "base");
  git("switch", "-c", "unpublished");
  writeFileSync(path.join(directory, "committed.txt"), "committed\n");
  git("add", ".");
  git("commit", "-m", "change");
  writeFileSync(path.join(directory, "review-marker.txt"), marker);
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
      await testInfo.attach("reviewer in author checkout", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await deleteAgentViaAPI(request, reviewer);
      agents.pop();
      await page.goto("/agents/" + author, { waitUntil: "domcontentloaded" });
      await expect(settledTurns(page)).toHaveCount(1, { timeout: 45_000 });
      await newSettledTurn(
        page,
        "proof-reviewed-checkout",
        "Checkout marker " + marker
      );
    } finally {
      for (const id of agents.reverse()) await deleteAgentViaAPI(request, id);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}
