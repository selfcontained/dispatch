import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  authHeaders,
  cleanupE2EAgents,
  createAgentViaAPI,
  trackAgent,
} from "./helpers";

const port = process.env.E2E_PORT ?? "8788";
const protocol = process.env.TLS_CERT ? "https" : "http";
const api = `${protocol}://127.0.0.1:${port}`;
async function callTool(
  request: APIRequestContext,
  agentId: string,
  name: string,
  args: Record<string, unknown>
) {
  const response = await request.post(`${api}/api/mcp/${agentId}`, {
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
  expect(response.status()).toBe(200);
  const body = await response.text();
  const payload = JSON.parse(
    body.startsWith("{")
      ? body
      : body
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6)
  );
  expect(payload.error).toBeUndefined();
  expect(payload.result.isError, JSON.stringify(payload.result)).not.toBe(true);
  return payload.result;
}

test("code owners launch once, preserve context, and show tracked findings", async ({
  page,
  request,
}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dispatch-owner-e2e-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  try {
    await mkdir(path.join(root, ".dispatch/personas"), { recursive: true });
    await mkdir(path.join(root, "src"));
    for (const slug of ["runtime-owner", "contract-owner"]) {
      await writeFile(
        path.join(root, `.dispatch/personas/${slug}.md`),
        `---\nname: ${slug}\ndescription: Reviews this fixture subsystem\nfeedbackFormat: findings\n---\nCheck changed subsystem contracts.\n`
      );
    }
    await writeFile(
      path.join(root, ".dispatch/codeowners.json"),
      JSON.stringify({
        version: 1,
        rules: [
          { paths: ["src/**"], personas: ["runtime-owner"] },
          {
            paths: ["src/contract.ts"],
            personas: ["contract-owner", "runtime-owner"],
          },
        ],
        fallback: ["code-review"],
      })
    );
    await writeFile(
      path.join(root, "src/contract.ts"),
      "export const value = 1;\n"
    );
    git("init", "-b", "main");
    git("-c", "user.name=E2E", "-c", "user.email=e2e@example.com", "add", ".");
    git(
      "-c",
      "user.name=E2E",
      "-c",
      "user.email=e2e@example.com",
      "commit",
      "-m",
      "base"
    );
    await writeFile(
      path.join(root, "src/contract.ts"),
      "export const value = 2;\n"
    );
    await writeFile(path.join(root, "README.md"), "Uncovered path\n");
    // A parent launched below the repo root must still route the whole checkout.
    const parent = await createAgentViaAPI(request, {
      cwd: path.join(root, "src"),
      useWorktree: false,
    });
    const briefing =
      "Changed the contract value; preserve downstream compatibility.";
    const preview = await callTool(request, parent.id, "launch_owner_reviews", {
      context: briefing,
      dryRun: true,
    });
    expect(preview.structuredContent.launched).toEqual([]);
    expect(preview.structuredContent.uncoveredFiles).toEqual(["README.md"]);
    const launched = await callTool(
      request,
      parent.id,
      "launch_owner_reviews",
      { context: briefing }
    );
    const owners = launched.structuredContent.launched as Array<{
      persona: string;
      agentId: string;
    }>;
    expect(launched.structuredContent.failures).toEqual([]);
    expect(owners.map((owner) => owner.persona).sort()).toEqual([
      "code-review",
      "contract-owner",
      "runtime-owner",
    ]);
    for (const owner of owners) trackAgent(owner.agentId);
    const contractOwner = owners.find(
      (owner) => owner.persona === "contract-owner"
    )!;
    await expect
      .poll(async () => {
        const response = await request.get(
          `/api/v1/agents/${contractOwner.agentId}`,
          { headers: authHeaders() }
        );
        return (await response.json()).agent.status;
      })
      .not.toBe("creating");
    const posted = await callTool(request, contractOwner.agentId, "post", {
      to: parent.id,
      review: {
        summary: "Owner review fixture.",
        findings: [
          {
            severity: "major",
            path: "src/contract.ts",
            line: 1,
            title: "Preserve downstream compatibility",
            body: "Fixture finding: preserve downstream contract compatibility.",
          },
        ],
      },
    });
    const receipt = JSON.parse(posted.content[0].text);
    expect(receipt.findings).toHaveLength(1);
    await page.goto(`/agents/${parent.id}/changes`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByTestId("agent-sidebar")).toBeVisible();
    const finding = page.getByTestId("diff-finding");
    await expect(finding).toHaveCount(1);
    await expect(finding).toHaveAttribute(
      "data-finding-key",
      receipt.findings[0].id
    );
    await finding.getByTestId("diff-finding-header").click();
    await expect(finding).toHaveAttribute("data-expanded", "true");
    await expect(finding).toContainText(
      "Fixture finding: preserve downstream contract compatibility."
    );
    await page.screenshot({
      path: "/tmp/dispatch-code-owner-reviews-e2e.png",
      fullPage: true,
    });
  } finally {
    await cleanupE2EAgents(request);
    await rm(root, { recursive: true, force: true });
  }
});
