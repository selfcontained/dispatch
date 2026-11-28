#!/usr/bin/env node
// Stands between an agent host and the fake ACP agent and records what the
// host gave the engine: its argv, its environment, and every JSON-RPC line
// the host wrote to it. RECORD_DIR names where the record goes.
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeAgent = path.resolve(
  here,
  "../../../../e2e/fixtures/fake-acp-agent.mjs"
);
const dir = process.env.RECORD_DIR;
if (!dir) throw new Error("RECORD_DIR is required");

writeFileSync(
  path.join(dir, "adapter.json"),
  JSON.stringify({ argv: process.argv.slice(2), env: process.env })
);
const agent = spawn(process.execPath, [fakeAgent, ...process.argv.slice(2)], {
  stdio: ["pipe", "inherit", "inherit"],
});
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    appendFileSync(path.join(dir, "stdin.jsonl"), buffer.slice(0, index + 1));
    buffer = buffer.slice(index + 1);
  }
  agent.stdin.write(chunk);
});
process.stdin.on("end", () => agent.stdin.end());
agent.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => agent.kill(signal));
