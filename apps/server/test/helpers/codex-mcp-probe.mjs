// Forward the production adapter's app-server traffic unchanged. After its
// first thread/start, ask the real engine to call the service tool without a
// model turn. No MCP configuration or bearer is supplied by this probe.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const appServer = args[0] === "app-server";
const codex = spawn(process.env.FIXTURE_CODEX_BIN, args, {
  stdio: appServer ? ["pipe", "pipe", "inherit"] : "inherit",
});
codex.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => codex.kill(signal));

if (appServer) {
  const probeId = "dispatch-first-launch-probe";
  let threadStartId;
  let probed = false;
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const request = JSON.parse(line);
    if (threadStartId === undefined && request.method === "thread/start")
      threadStartId = request.id;
    codex.stdin.write(line + "\n");
  });
  input.on("close", () => codex.stdin.end());
  const output = createInterface({ input: codex.stdout });
  output.on("line", (line) => {
    const response = JSON.parse(line);
    if (response.id === probeId && !response.method) {
      const succeeded =
        !response.error &&
        !response.result?.isError &&
        JSON.stringify(response.result?.content ?? []).includes(
          "fixture-template"
        );
      writeFileSync(
        process.env.FIXTURE_PROBE_RESULT,
        succeeded ? "ok" : "tool failed"
      );
      return;
    }
    process.stdout.write(line + "\n");
    if (
      probed ||
      threadStartId === undefined ||
      response.id !== threadStartId ||
      response.method
    )
      return;
    probed = true;
    const threadId = response.result?.thread?.id;
    if (!threadId) {
      writeFileSync(process.env.FIXTURE_PROBE_RESULT, "thread failed");
      return;
    }
    codex.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: probeId,
        method: "mcpServer/tool/call",
        params: {
          threadId,
          server: "service",
          tool: "create_template",
          arguments: { name: "first launch", fullAccess: false },
        },
      }) + "\n"
    );
  });
}
