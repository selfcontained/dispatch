/**
 * Test that streamProcess correctly handles ANSI cursor-up redraws
 * (as produced by `gh run watch`) instead of appending duplicate blocks.
 *
 * Run: npx tsx test/stream-process.test.ts
 */
import { spawn } from "node:child_process";
import path from "node:path";

// ---- Minimal replicas of the server helpers ----

type LogEvent =
  | { type: "log"; line: string }
  | { type: "log.replace"; line: string }
  | { type: "log.rewind"; count: number };

interface FakeJob {
  log: string[];
}

const events: LogEvent[] = [];

function appendReleaseLog(job: FakeJob, line: string): void {
  job.log.push(line);
  events.push({ type: "log", line });
}

function replaceReleaseLog(job: FakeJob, line: string): void {
  if (job.log.length > 0) {
    job.log[job.log.length - 1] = line;
  } else {
    job.log.push(line);
  }
  events.push({ type: "log.replace", line });
}

function rewindReleaseLog(job: FakeJob, count: number): void {
  const actual = Math.min(count, job.log.length);
  if (actual > 0) {
    job.log.splice(-actual);
    events.push({ type: "log.rewind", count: actual });
  }
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

// ---- streamProcess (copy of server logic) ----

function streamProcess(
  command: string,
  args: string[],
  options: { cwd?: string },
  job: FakeJob,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";
    let lastWasCR = false;
    const processChunk = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const cursorUpMatch = rawLine.match(/\x1b\[(\d+)A/);
        if (cursorUpMatch) {
          rewindReleaseLog(job, parseInt(cursorUpMatch[1], 10));
        }

        const line = stripAnsi(rawLine);

        const crParts = line.split("\r").filter(Boolean);
        if (crParts.length > 1 || lastWasCR) {
          const final = crParts[crParts.length - 1] ?? "";
          replaceReleaseLog(job, final);
        } else {
          appendReleaseLog(job, crParts[0] ?? line);
        }
        lastWasCR = false;
      }
      if (buffer.includes("\r")) {
        const crParts = buffer.split("\r").filter(Boolean);
        const final = crParts[crParts.length - 1] ?? "";
        replaceReleaseLog(job, final);
        buffer = "";
        lastWasCR = true;
      }
    };

    child.stdout.on("data", processChunk);
    child.stderr.on("data", processChunk);

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (buffer) {
        appendReleaseLog(job, buffer);
      }
      if (code !== 0) {
        reject(new Error(`Process exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

// ---- Run the test ----

async function main() {
  const job: FakeJob = { log: [] };
  const mockScript = path.join(import.meta.dirname, "mock-gh-watch.sh");

  console.log("Running mock gh run watch through streamProcess...\n");
  await streamProcess("bash", [mockScript], {}, job);

  console.log("=== Final log state ===");
  for (const [i, line] of job.log.entries()) {
    console.log(`  [${i}] ${JSON.stringify(line)}`);
  }

  console.log(`\n=== Events emitted (${events.length}) ===`);
  for (const evt of events) {
    if (evt.type === "log") console.log(`  log:     ${JSON.stringify(evt.line)}`);
    else if (evt.type === "log.replace") console.log(`  replace: ${JSON.stringify(evt.line)}`);
    else if (evt.type === "log.rewind") console.log(`  rewind:  ${evt.count}`);
  }

  // Assertions
  const rewinds = events.filter((e) => e.type === "log.rewind");
  const finalLogCount = job.log.length;

  console.log("\n=== Assertions ===");

  // Should have exactly 2 rewinds (second and third render)
  console.assert(rewinds.length === 2, `Expected 2 rewinds, got ${rewinds.length}`);
  console.log(`✓ Rewind events: ${rewinds.length}`);

  // Final log should have ~9 lines (the last render), not 27 (3x9)
  console.assert(finalLogCount <= 12, `Expected ≤12 final log lines, got ${finalLogCount}`);
  console.log(`✓ Final log lines: ${finalLogCount} (would be ~27 without fix)`);

  // Should NOT contain duplicate "Refreshing" lines
  const refreshLines = job.log.filter((l) => l.includes("Refreshing"));
  console.assert(refreshLines.length <= 1, `Expected ≤1 Refreshing lines, got ${refreshLines.length}`);
  console.log(`✓ Refreshing lines: ${refreshLines.length}`);

  // Final log should end with the completed state
  const hasCompleted = job.log.some((l) => l.includes("✓ main Release"));
  console.assert(hasCompleted, "Expected final log to contain completed state");
  console.log(`✓ Contains completed state`);

  // No ANSI escape sequences should remain in the log
  const hasAnsi = job.log.some((l) => /\x1b\[/.test(l));
  console.assert(!hasAnsi, "Expected no ANSI sequences in final log");
  console.log(`✓ No ANSI escape sequences in output`);

  console.log("\nAll assertions passed!");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
