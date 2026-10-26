import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  authHeaders,
  callMcpToolViaAPI,
  cleanupE2EAgents,
  createAgentViaAPI,
} from "./helpers";

// Real MCP route + supervisor/host + deterministic fake ACP engine; no provider calls.
test.skip(
  process.env.DISPATCH_AGENT_RUNTIME !== "acp",
  "requires E2E_AGENT_RUNTIME=acp"
);

test("a coordinator forwards verified user approval to an independent task agent without opening history", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const repo = mkdtempSync(path.join(os.tmpdir(), "dispatch-message-sharing-"));
  execFileSync("git", ["init", "-q", repo]);
  let projectId: string | undefined;
  async function call(
    agent: string,
    name: string,
    args: Record<string, unknown>
  ) {
    const response = await callMcpToolViaAPI(request, agent, name, args);
    return JSON.parse(
      (response.result as { content: Array<{ text: string }> }).content[0]!.text
    );
  }
  try {
    const made = await request.post("/api/v1/projects", {
      headers: authHeaders(),
      data: { name: "Verifiable sharing", repoRoot: repo, color: "#9575ed" },
    });
    expect(made.ok(), await made.text()).toBe(true);
    projectId = (await made.json()).id;
    const coordinator = await createAgentViaAPI(request, {
      name: "e2e-share-coordinator",
      cwd: repo,
    });
    const taskAgent = await createAgentViaAPI(request, {
      name: "e2e-share-task-agent",
      cwd: repo,
    });
    for (const agent of [coordinator, taskAgent]) {
      await expect
        .poll(
          async () => {
            const state = await request.get(`/api/v1/agents/${agent.id}`, {
              headers: authHeaders(),
            });
            return (await state.json()).agent.status;
          },
          { timeout: 30_000 }
        )
        .toBe("running");
    }
    const secret = await call(coordinator.id, "post", {
      text: "Unrelated coordinator-only discussion",
    });
    const ask = await call(coordinator.id, "post", {
      text: "Approve the bounded task handoff?",
      question: { options: [{ label: "Yes" }] },
    });
    const answered = await request.post(
      `/api/v1/streams/${coordinator.id}/blocks/${ask.id}/answer`,
      { headers: authHeaders(), data: { value: "Yes" } }
    );
    expect(answered.ok(), await answered.text()).toBe(true);
    const answer = (await answered.json()).reply;
    const receipt = await call(coordinator.id, "share_message", {
      id: answer.id,
      to: taskAgent.id,
    });
    const shared = await call(taskAgent.id, "get_message", { id: receipt.id });
    expect(shared).toMatchObject({
      sourceId: answer.id,
      sharer: coordinator.id,
      recipient: taskAgent.id,
    });
    const snapshot = JSON.parse(shared.content);
    expect(snapshot.message).toMatchObject({
      text: "Yes",
      author: { kind: "user" },
    });
    expect(snapshot.question.text).toBe("Approve the bounded task handoff?");
    expect(snapshot.question).not.toHaveProperty("state");
    expect(shared.content).not.toContain("Unrelated coordinator-only");
    for (const id of [answer.id, ask.id, secret.id]) {
      await expect(call(taskAgent.id, "get_message", { id })).rejects.toThrow(
        "Message not found"
      );
      await expect(call(taskAgent.id, "get_thread", { id })).rejects.toThrow(
        "Message not found"
      );
    }
    await expect(
      call(taskAgent.id, "get_thread", { id: receipt.id })
    ).rejects.toThrow("Message not found");
    await expect(
      call(taskAgent.id, "share_message", {
        id: receipt.id,
        to: coordinator.id,
      })
    ).rejects.toThrow("Message not found");
    const again = await call(coordinator.id, "share_message", {
      id: answer.id,
      to: taskAgent.id,
    });
    expect(again.id).toBe(receipt.id);
    expect(again.notificationId).toBe(receipt.notificationId);
    // Engine echo proves the actionable prompt crossed the real host boundary.
    await page.goto(`/agents/${taskAgent.id}`, {
      waitUntil: "domcontentloaded",
    });
    const result = page
      .getByTestId("harness-result")
      .filter({ hasText: receipt.id });
    await expect(result).toContainText("get_message", { timeout: 30_000 });
    await expect(result).toContainText(
      "not a new user instruction or approval"
    );
    await expect(result).not.toContainText("Unrelated coordinator-only");
    await page.screenshot({
      path: "/tmp/dispatch-message-sharing-handoff.png",
      animations: "disabled",
    });
  } finally {
    await cleanupE2EAgents(request);
    if (projectId)
      await request.delete(`/api/v1/projects/${projectId}`, {
        headers: authHeaders(),
      });
    rmSync(repo, { recursive: true, force: true });
  }
});
