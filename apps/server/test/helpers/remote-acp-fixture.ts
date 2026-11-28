import { proveFileTransfer } from "../../../../e2e/fixtures/runner-file-transfer.mjs";
// A standalone deterministic ACP provider for the isolated runner proof.
import { execFileSync } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createFakeAcpAgent } from "./fake-acp-agent.js";

const fake = createFakeAcpAgent({
  supportsImages: true,
  async turn(prompt, emit, ask) {
    const session =
      fake.seen.newSession.at(-1) ?? fake.seen.resumeSession.at(-1)!;
    if (prompt.includes("proof-file-transfer")) {
      await proveFileTransfer(
        prompt,
        fake.seen.promptBlocks.at(-1),
        session,
        Client,
        StreamableHTTPClientTransport
      );
      return "end_turn";
    }
    const report = (text: string) =>
      emit({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      });
    const namespace = /^proof-conformance-env:(CONFORMANCE_[A-Z_]+)$/.exec(
      prompt
    );
    if (namespace) {
      await report(
        JSON.stringify({
          env: process.env[namespace[1]!] ?? null,
          mcp: (session.mcpServers ?? []).map(({ name }) => name),
        })
      );
      return "end_turn";
    }
    if (
      session.cwd.startsWith("/opt/dispatch-guest-") ||
      prompt.includes("proof-count")
    ) {
      await appendFile(
        path.join(session.cwd, "provider-invocations"),
        "called\n"
      );
    }
    if (prompt.includes("proof-launch-branch")) {
      const branch = execFileSync("git", ["branch", "--show-current"], {
        cwd: session.cwd,
        encoding: "utf8",
      }).trim();
      await report("Launch branch " + branch + "\n");
    }
    if (prompt.includes("proof-reviewed-checkout")) {
      const marker = (
        await readFile(path.join(session.cwd, "review-marker.txt"), "utf8")
      ).trim();
      await report("Checkout marker " + marker);
    }
    const sleep = /proof-delay:(\d+)/.exec(prompt);
    if (sleep) {
      await report("Guest turn waiting for reconnect.");
      await new Promise((resolve) => setTimeout(resolve, Number(sleep[1])));
    }
    if (prompt.includes("prove-permission")) {
      const answer = await ask({
        options: [
          { kind: "allow_once", name: "Allow once", optionId: "allow" },
          { kind: "reject_once", name: "Deny", optionId: "deny" },
        ],
      });
      if (
        answer.outcome.outcome === "selected" &&
        answer.outcome.optionId === "allow"
      ) {
        await writeFile(
          path.join(session.cwd, "protected-action"),
          "allowed\n"
        );
      }
      await report("Guest permission answered.");
    }
    if (prompt.includes("prove-marker") || prompt.includes("post-private-pr")) {
      const endpoint = (session.mcpServers ?? []).find(
        (entry) => "url" in entry && "headers" in entry
      );
      if (!endpoint || !("url" in endpoint) || !("headers" in endpoint))
        throw new Error("Missing Dispatch MCP endpoint");
      const client = new Client({
        name: "dispatch-runner-fixture",
        version: "1",
      });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(endpoint.url), {
          requestInit: {
            headers: Object.fromEntries(
              endpoint.headers.map(({ name, value }) => [name, value])
            ),
          },
        })
      );
      try {
        if (prompt.includes("post-private-pr")) {
          const post = await client.callTool({
            name: "post",
            arguments: {
              text: "Private checkout PR",
              attachments: [
                {
                  type: "pr",
                  url: "https://github.com/fixture-scratch/private/pull/42",
                  title: "Fixture PR",
                },
              ],
            },
          });
          if (post.isError) throw new Error(JSON.stringify(post.content));
        } else {
          const marker = (
            await readFile(path.join(session.cwd, "marker.txt"), "utf8")
          ).trim();
          await report(`Guest marker ${marker}`);
          const post = await client.callTool({
            name: "post",
            arguments: { text: `Posted from Lima: ${marker}` },
          });
          if (post.isError) throw new Error(JSON.stringify(post.content));
          const repo = await client.callTool({
            name: "repo_proof",
            arguments: {},
          });
          if (repo.isError) throw new Error(JSON.stringify(repo.content));
          await report(
            ` Approved repo operation: ${JSON.stringify(repo.content)}`
          );
        }
      } finally {
        await client.close();
      }
    } else if (!sleep) {
      await report("Local or guest fixture turn completed.");
    } else {
      await report(" Guest turn completed after reconnect.");
    }
    return "end_turn";
  },
});
process.stdin.pipe(fake.child.stdin);
fake.child.stdout.pipe(process.stdout);
