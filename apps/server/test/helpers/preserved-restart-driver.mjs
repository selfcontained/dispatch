import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// A preserved host can settle while the API restarts. Enforce that ordering
// before the parent's first read without blocking its HTTP client's event loop.
async function main() {
  const { bin, cwd, suffix, journal, identity, hostPid, deadline } = JSON.parse(
    process.argv[2]
  );
  // Reserve cancellation time INSIDE the parent's existing 60s deadline.
  if (!Number.isFinite(deadline) || Date.now() >= deadline - 1_000) {
    throw new Error("Restart command deadline exhausted");
  }
  const current = firstTurnIdentity(journal, identity.agentId);
  for (const key of ["agentId", "journalId", "startedSeq", "chatMessageId"]) {
    if (current[key] !== identity[key])
      throw new Error(`First turn ${key} changed before restart`);
  }
  process.kill(hostPid, 0);
  // This group is created by this driver. Existing preserved hosts have their
  // own groups and are never signalled. Keep ownership through the journal wait.
  const child = spawn(bin, ["restart", "--suffix", suffix], {
    cwd,
    env: process.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let cancelled;
  let signalExitCode;
  let rejectCancellation;
  const cancellation = new Promise((_, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (error) => {
    if (cancelled) return;
    cancelled = error;
    rejectCancellation(error);
  };
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
  // Handle rejections even when cancellation wins the race before child.close.
  closed.catch(() => {});
  for (const [stream, append] of [
    [
      child.stdout,
      (text) => {
        stdout += text;
        return Buffer.byteLength(stdout);
      },
    ],
    [
      child.stderr,
      (text) => {
        stderr += text;
        return Buffer.byteLength(stderr);
      },
    ],
  ]) {
    stream.setEncoding("utf8");
    stream.on("data", (text) => {
      if (cancelled) return;
      if (append(text) > 1024 * 1024)
        cancel(new Error("Restart output exceeded maxBuffer"));
    });
  }
  const onTerm = () => {
    signalExitCode = 143;
    cancel(new Error("Restart driver cancelled by SIGTERM"));
  };
  const onInt = () => {
    signalExitCode = 130;
    cancel(new Error("Restart driver cancelled by SIGINT"));
  };
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  const timer = setTimeout(
    () => cancel(new Error("Restart command deadline exhausted")),
    deadline - 1_000 - Date.now()
  );
  const work = (async () => {
    const { status, signal } = await closed;
    if (cancelled) throw cancelled;
    if (status !== 0)
      throw Object.assign(new Error(`Restart exited ${status ?? signal}`), {
        status,
        signal,
        stdout,
        stderr,
      });
    process.stdout.write(stdout);
    const conditionDeadline = Date.now() + 20_000;
    while (Date.now() < conditionDeadline) {
      if (cancelled) throw cancelled;
      const turn = readTurn(journal, identity.agentId);
      for (const key of [
        "agentId",
        "journalId",
        "startedSeq",
        "chatMessageId",
      ]) {
        if (turn[key] !== identity[key])
          throw new Error(`First turn ${key} changed after restart`);
      }
      if (turn.settled) {
        process.stdout.write(
          `\nPreserved first-turn settled: ${JSON.stringify(turn)}\n`
        );
        return;
      }
      await delay(100);
    }
    throw new Error("condition did not become true within 20s");
  })();
  try {
    await Promise.race([work, cancellation]);
  } catch (error) {
    cancel(error);
    // Signal only the fresh group we own, including descendants that outlive
    // their launcher. Do not let the driver exit (and parent teardown begin)
    // merely because that launcher exited first.
    await stopOwnedGroup(
      child.pid,
      signalExitCode === 130 ? "SIGINT" : "SIGTERM"
    );
    await closed.catch(() => {});
    await work.catch(() => {});
    if (signalExitCode) process.exitCode = signalExitCode;
    throw Object.assign(error, { stdout, stderr });
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGTERM", onTerm);
    process.removeListener("SIGINT", onInt);
  }
}

async function groupRunning(pgid) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("ps", ["-axo", "pgid=,stat="], {
      timeout: 100,
    }));
  } catch {
    // Failure to inspect must not bypass escalation. Conservatively assume
    // survivors unless the owned group is definitely gone.
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  }
  return stdout.split("\n").some((line) => {
    const [group, state] = line.trim().split(/\s+/);
    // Zombies cannot execute or race cleanup; their adopter owns reaping.
    return Number(group) === pgid && state && !state.startsWith("Z");
  });
}

async function stopOwnedGroup(pgid, signal) {
  if (!pgid) return;
  const send = (value) => {
    try {
      process.kill(-pgid, value);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  send(signal);
  const grace = Date.now() + 250;
  while (await groupRunning(pgid)) {
    if (Date.now() >= grace) break;
    await delay(25);
  }
  if (await groupRunning(pgid)) send("SIGKILL");
  const killedDeadline = Date.now() + 500;
  while (await groupRunning(pgid)) {
    if (Date.now() >= killedDeadline)
      throw new Error(
        `Restart process group ${pgid} did not stop after SIGKILL`
      );
    await delay(25);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode ||= 1;
  }
}
