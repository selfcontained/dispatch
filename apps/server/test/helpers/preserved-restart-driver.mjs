import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** @param {string} journal @param {string} agentId */
function readTurn(journal, agentId) {
  const lines = readFileSync(journal, "utf8").split("\n");
  // A host may currently be appending the last record. Only inspect complete
  // lines; malformed complete records remain fatal.
  lines.pop();
  const entries = lines.filter(Boolean).map((line) => JSON.parse(line));
  const journalId = entries[0]?.journalId;
  if (typeof journalId !== "string" || !journalId)
    throw new Error("Missing journal identity");
  let previous = 0;
  for (const entry of entries) {
    if (
      entry.journalId !== journalId ||
      !Number.isInteger(entry.seq) ||
      entry.seq <= previous
    ) {
      throw new Error("Journal identity/sequence changed");
    }
    previous = entry.seq;
    if (entry.event?.agentId !== undefined && entry.event.agentId !== agentId) {
      throw new Error("Unexpected journal agent");
    }
  }
  const turns = entries.filter(({ event }) => event?.type === "turn");
  if (turns.some(({ event }) => event.agentId !== agentId)) {
    throw new Error("Unexpected first turn agent");
  }
  const starts = turns.filter(({ event }) => event.state === "started");
  if (starts.length !== 1)
    throw new Error("Expected exactly one first turn; another turn started");
  const started = starts[0];
  const chatMessageId = started.event.source?.chatMessageId;
  if (
    typeof chatMessageId !== "string" ||
    !chatMessageId ||
    started.event.agentId !== agentId ||
    started.event.source?.conversation?.streamId !== agentId
  ) {
    throw new Error("Missing first turn agent/source identity");
  }
  const settlements = turns.filter(({ event }) => event.state === "settled");
  if (
    settlements.length > 1 ||
    settlements.some(
      (entry) => entry.seq <= started.seq || entry.event.error !== undefined
    )
  ) {
    throw new Error("Invalid/error settlement for first turn");
  }
  if (
    turns.some(
      ({ event }) => event.state !== "started" && event.state !== "settled"
    )
  ) {
    throw new Error("Unexpected first turn state");
  }
  return {
    agentId,
    journalId,
    startedSeq: started.seq,
    chatMessageId,
    settled: settlements.length === 1,
  };
}

/** @param {string} journal @param {string} agentId */
export function firstTurnIdentity(journal, agentId) {
  const turn = readTurn(journal, agentId);
  if (turn.settled)
    throw new Error("First turn must still be in flight at restart entry");
  return turn;
}

async function main() {
  const { bin, cwd, suffix, journal, identity, hostPid } = JSON.parse(
    process.argv[2]
  );
  // Check again immediately before the child starts restart, not just in parent.
  const current = firstTurnIdentity(journal, identity.agentId);
  for (const key of ["agentId", "journalId", "startedSeq", "chatMessageId"]) {
    if (current[key] !== identity[key])
      throw new Error(`First turn ${key} changed before restart`);
  }
  process.kill(hostPid, 0);
  const output = execFileSync(bin, ["restart", "--suffix", suffix], {
    cwd,
    env: process.env,
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  process.stdout.write(output);
  // Same condition deadline/poll interval as the parent's original journal wait.
  // Parent also bounds this entire driver to 60s, so this adds no command allowance.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const turn = readTurn(journal, identity.agentId);
    for (const key of ["agentId", "journalId", "startedSeq", "chatMessageId"]) {
      if (turn[key] !== identity[key])
        throw new Error(`First turn ${key} changed after restart`);
    }
    if (turn.settled) {
      process.stdout.write(
        `\nControlled first-turn barrier: ${JSON.stringify(turn)}\n`
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("condition did not become true within 20s");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
