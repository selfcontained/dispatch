/*
 * launch_agent from a runner agent into another folder on its runner (D7):
 * the folder is resolved and used as the workload account, the child stays
 * on the caller's runner, and archive never touches the folder. With a
 * worktree, the worktree is the runner's own checkout and only it is removed.
 */
import { expect, test, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { authHeaders, deleteAgentViaAPI } from "../helpers";
import { enrollViaUi, guest, repositoryProject, state } from "./harness";

const host = (id: string) =>
  JSON.parse(guest("scratch", `cat /var/lib/runner/hosts/${id}/launch.json`));

async function mcpCall(
  request: APIRequestContext,
  id: string,
  token: string,
  name: string,
  args: Record<string, unknown>
) {
  const response = await request.post("/api/mcp/" + id, {
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer " + token,
    },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
  const body = await response.text();
  expect(response.ok(), body).toBe(true);
  const line = body.split("\n").find((line) => line.startsWith("data: "));
  expect(line, body).toBeDefined();
  return JSON.parse(line!.slice(6)).result as {
    isError?: boolean;
    content?: { text: string }[];
    structuredContent?: { agentId?: string };
  };
}

async function running(request: APIRequestContext, id: string) {
  await expect
    .poll(
      async () =>
        (
          await (
            await request.get("/api/v1/agents/" + id, {
              headers: authHeaders(),
            })
          ).json()
        ).agent?.status,
      { timeout: 60_000 }
    )
    .toBe("running");
}

/** A listing with each file's digest, as the workload sees the folder. */
const contents = (folder: string) =>
  guest(
    "scratch",
    `cd '${folder}' && find . -path ./.git -prune -o -type f -print | sort | xargs sha256sum`
  );

test("launches a child in a folder its runner account names, and archive leaves it", async ({
  page,
  request,
}) => {
  const agents: string[] = [];
  const suffix = randomUUID().slice(0, 8);
  const folder = `/home/guest/named-${suffix}`;
  const repo = `/home/guest/named-repo-${suffix}`;
  try {
    const scratch = await enrollViaUi(page, request, "scratch");
    const projectId = await repositoryProject(request, "scratch");
    const created = await request.post("/api/v1/agents", {
      headers: authHeaders(),
      data: {
        name: "Named folder caller",
        type: "claude",
        cwd: "",
        runner: scratch,
        projectId,
        useWorktree: false,
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const callerId: string = (await created.json()).agent.id;
    agents.push(callerId);
    await running(request, callerId);
    const token: string = host(callerId).mcp.token;

    // Folders the workload owns: a plain folder and a Git repository.
    guest(
      "scratch",
      [
        `mkdir -p '${folder}' '${repo}'`,
        `printf 'the user work\\n' > '${folder}/keep.txt'`,
        `cd '${repo}' && git init -q -b main && git config user.email f@x && git config user.name f`,
        `printf 'source\\n' > '${repo}/keep.txt' && git -C '${repo}' add . && git -C '${repo}' commit -qm base`,
        `chown -R 1500:1500 '${folder}' '${repo}'`,
      ].join(" && ")
    );
    const before = contents(folder);
    const repoBefore = contents(repo);

    // A folder the workload cannot reach (inside another account's private
    // home) or that is not there: main's error, nothing launched.
    for (const cwd of [
      "/root/.ssh",
      `${folder}/missing`,
      `${folder}/keep.txt`,
    ]) {
      const refused = await mcpCall(request, callerId, token, "launch_agent", {
        name: "unreachable",
        prompt: "work",
        cwd,
      });
      expect(refused.isError, cwd).toBe(true);
      expect(refused.content?.[0]?.text, cwd).toContain(
        "Working directory does not exist or is not a directory."
      );
    }

    // The plain folder: the child's host starts there, on this runner.
    const plain = await mcpCall(request, callerId, token, "launch_agent", {
      name: "named folder",
      prompt: "work",
      cwd: folder,
    });
    expect(plain.isError, JSON.stringify(plain)).toBeFalsy();
    const plainId = plain.structuredContent!.agentId!;
    agents.push(plainId);
    await running(request, plainId);
    expect(host(plainId).cwd).toBe(folder);
    const plainRow = (
      await (
        await request.get("/api/v1/agents/" + plainId, {
          headers: authHeaders(),
        })
      ).json()
    ).agent;
    expect(plainRow.cwd).toBe(folder);

    // An independent worktree from the repository: made as the runner's own
    // checkout, from that folder.
    const tree = await mcpCall(request, callerId, token, "launch_agent", {
      name: "named worktree",
      prompt: "work",
      cwd: repo,
      useWorktree: true,
      createNewBranch: true,
      child: false,
    });
    expect(tree.isError, JSON.stringify(tree)).toBeFalsy();
    const treeId = tree.structuredContent!.agentId!;
    agents.push(treeId);
    await running(request, treeId);
    const checkout = `/var/lib/runner/sessions/${treeId}/checkout`;
    expect(host(treeId).cwd).toBe(checkout);
    expect(
      guest(
        "scratch",
        `git -c safe.directory='*' -C '${checkout}' rev-parse --path-format=absolute --git-common-dir`
      ).trim()
    ).toBe(`${repo}/.git`);

    // A folder agent launches as a local agent in a folder does: in its own
    // folder, a worktree from it, and another named folder.
    const launchFrom = async (from: string, args: Record<string, unknown>) => {
      const reply = await mcpCall(
        request,
        from,
        host(from).mcp.token,
        "launch_agent",
        {
          prompt: "work",
          child: false,
          ...args,
        }
      );
      expect(reply.isError, JSON.stringify(reply)).toBeFalsy();
      const id = reply.structuredContent!.agentId!;
      agents.push(id);
      await running(request, id);
      return id;
    };
    const repoAgent = await launchFrom(callerId, {
      name: "in repo",
      cwd: repo,
    });
    expect(host(repoAgent).cwd).toBe(repo);
    const same = await launchFrom(repoAgent, { name: "same folder" });
    expect(host(same).cwd).toBe(repo);
    const chained = await launchFrom(repoAgent, {
      name: "worktree from folder",
      useWorktree: true,
      createNewBranch: true,
    });
    const chainedCheckout = `/var/lib/runner/sessions/${chained}/checkout`;
    expect(host(chained).cwd).toBe(chainedCheckout);
    expect(
      guest(
        "scratch",
        `git -c safe.directory='*' -C '${chainedCheckout}' rev-parse --path-format=absolute --git-common-dir`
      ).trim()
    ).toBe(`${repo}/.git`);
    const elsewhere = await launchFrom(repoAgent, {
      name: "another folder",
      cwd: folder,
    });
    expect(host(elsewhere).cwd).toBe(folder);
    // The folder agent archives first: its folder stays, and the agent that
    // shares it is neither stopped nor blocked.
    await deleteAgentViaAPI(request, repoAgent, "auto");
    expect(contents(repo)).toBe(repoBefore);
    await running(request, same);
    for (const id of [same, elsewhere, chained])
      await deleteAgentViaAPI(request, id, "auto");
    expect(contents(repo)).toBe(repoBefore);
    expect(contents(folder)).toBe(before);
    await expect
      .poll(
        () =>
          guest(
            "scratch",
            `test -e '${chainedCheckout}' && echo kept || echo gone`
          ).trim(),
        { timeout: 60_000 }
      )
      .toBe("gone");

    // Archive: the plain folder byte-for-byte; only the worktree goes.
    await deleteAgentViaAPI(request, plainId, "auto");
    await deleteAgentViaAPI(request, treeId, "auto");
    expect(contents(folder)).toBe(before);
    expect(contents(repo)).toBe(repoBefore);
    // The release may finish after the row is gone; give it time, and say
    // what the checkout held if it stays.
    await expect
      .poll(
        () =>
          guest(
            "scratch",
            `test -e '${checkout}' && { echo kept; git -c safe.directory='*' -C '${checkout}' status --porcelain --branch; ls -la '${checkout}'; ls -la /var/lib/runner/bindings | grep '${treeId}'; for f in /var/lib/runner/bindings/${treeId}*; do echo \"$f: $(cat \"$f\" | tr '\\0' '@' | head -c 300)\"; done; ls -la /var/lib/runner/state 2>/dev/null | head -5; grep -h '${treeId}' /var/log/runner.log 2>/dev/null | tail -25; } || echo gone`
          ).trim(),
        { timeout: 60_000 }
      )
      .toBe("gone");
    expect(
      guest("scratch", `git -c safe.directory='*' -C '${repo}' worktree list`)
    ).not.toContain(checkout);
    expect(state.runners.scratch.container).toBeTruthy();
  } finally {
    for (const id of agents.reverse())
      await deleteAgentViaAPI(request, id).catch(() => {});
    guest("scratch", `rm -rf '${folder}' '${repo}'`);
  }
});
