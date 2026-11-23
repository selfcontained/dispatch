/*
 * `tsx src/cli.ts local|remote`: run one lane's scenarios, compare them with
 * the red baseline, and on the remote lane also run the reference client.
 * Exits non-zero on any unexpected result.
 */
import { startLocalLane } from "./lanes/local.js";
import { startRemoteLane } from "./lanes/remote.js";
import { walkthrough } from "./reference-client.js";
import { remoteScenarios } from "./scenarios.js";
import { turnText } from "./session.js";
import {
  compareBaseline,
  readBaseline,
  runLane,
  type Lane,
  type LaneName,
  type Result,
} from "./run.js";

const lane = process.argv[2] as LaneName;
const starts: Partial<Record<LaneName, () => Promise<Lane>>> = {
  local: startLocalLane,
  remote: startRemoteLane,
};
const start = starts[lane];
if (!start) {
  console.error("usage: cli.ts local|remote");
  process.exit(2);
}

const began = performance.now();
let started: Lane | undefined;
const errors: string[] = [];
const results: Result[] = await runLane(
  async () => {
    started = await start();
    // Kept open for the reference client below.
    return { ...started, close: async () => {} };
  },
  lane === "remote" ? remoteScenarios : undefined
);
const baseline = readBaseline();
errors.push(...compareBaseline(lane, results, baseline));

if (started) {
  try {
    for (const [namespace, name] of [
      ["CONFORMANCE_ATLAS", "atlas-tools"],
      ["CONFORMANCE_ORCHARD", "orchard-tools"],
    ] as const) {
      const guard = { path: `reference/${name}.txt`, content: name };
      await started.seed(guard.path, guard.content);
      const { description, exec, events } = await walkthrough(
        started.runner,
        `reference-${name}`,
        guard,
        {
          env: { [namespace]: name },
          mcp: [{ name, url: "https://example.invalid/mcp", token: "fixture" }],
          prompt: `proof-conformance-env:${namespace}`,
        },
        started.readGuard
      );
      if (exec.exitCode !== 0 || exec.stdout !== guard.content)
        throw new Error(`Unexpected exec ${JSON.stringify(exec)}`);
      const observed = JSON.parse(turnText(events));
      if (JSON.stringify(observed.mcp) !== JSON.stringify([name]))
        throw new Error(
          `The fixture engine did not receive MCP server ${name}.`
        );
      console.log(
        `reference client: ${description.displayName}, ${namespace}/${name}, turn and exec ok, session discarded`
      );
    }
  } catch (error) {
    errors.push(`reference client: ${(error as Error).message}`);
  } finally {
    await started.close();
  }
}

const green = results.filter((result) => result.ok);
const red = baseline.filter((entry) => entry.lane === lane);
const redCases = new Set(red.map((entry) => entry.scenario));
for (const result of results)
  if (
    result.error &&
    redCases.has(result.id) &&
    !result.id.endsWith("/pending")
  )
    console.log(`${result.id}: ${result.error}`);
const byTask = new Map<string, number>();
for (const entry of red)
  byTask.set(entry.task, (byTask.get(entry.task) ?? 0) + 1);
console.log(
  `${lane}: ${results.length} scenarios, ${green.length} green (${green
    .map((result) => `${result.id} ${result.ms} ms`)
    .join(", ")}), ${red.length} red baseline (${[...byTask]
    .sort()
    .map(([task, count]) => `${task} ${count}`)
    .join(", ")}), ${Math.round((performance.now() - began) / 1000)} s`
);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
}
