import { restoreLegacyMacLaunchAgentEnvironment } from "./startup/shell-environment.js";

// Modes of this binary, checked before anything else so none of them
// touches the server's environment restoration, database, or config:
//
// - `agent-host --state <dir>` runs one agent's ACP host.
// - `claude-acp` / `codex-acp` run the engine's ACP adapter over stdio.
//   The adapters ship inside this binary rather than as a global npm
//   install, so there is nothing for anyone to install or configure; each
//   one drives the engine CLI the user already has (see engine-spec.ts).
if (process.argv[2] === "agent-host") {
  await import("./agents/acp/host/main.js");
} else if (process.argv[2] === "claude-acp") {
  // The CLI entry, not the package's `main`: that one is a library whose
  // import starts nothing, and the adapter would sit there reading no stdin.
  await import("@agentclientprotocol/claude-agent-acp/dist/index.js");
} else if (process.argv[2] === "codex-acp") {
  await import("@agentclientprotocol/codex-acp/dist/index.js");
} else {
  await serve();
}

async function serve(): Promise<void> {
const shellEnvironment = await restoreLegacyMacLaunchAgentEnvironment();

const { app, shutdown, start } = await import("./server.js");

if (shellEnvironment.state === "resolved") {
  app.log.info({ shellEnvironment }, "Shell environment restored");
}

// Global error handlers — prevent silent crashes from background tasks
process.on("unhandledRejection", (reason) => {
  app.log.error({ err: reason }, "Unhandled promise rejection");
});

process.on("uncaughtException", async (err) => {
  setTimeout(() => process.exit(1), 5_000).unref();
  app.log.error({ err }, "Uncaught exception — shutting down");
  await shutdown(1);
});

start().catch(async (error) => {
  app.log.error(error);
  await shutdown(1);
});

process.on("SIGINT", async () => {
  await shutdown(0);
});

process.on("SIGTERM", async () => {
  await shutdown(0);
});
}
