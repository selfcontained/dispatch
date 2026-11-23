/*
 * `tsx src/cli.ts local|remote`: run one lane's scenarios, compare them with
 * the red baseline, and on the remote lane also run the reference client.
 * Exits non-zero on any unexpected result.
 */
import { startLocalLane } from "./lanes/local.js";
import { startRemoteLane } from "./lanes/remote.js";
import { walkthrough } from "./reference-client.js";
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
const results: Result[] = await runLane(async () => {
  started = await start();
  // Kept open for the reference client below.
  return { ...started, close: async () => {} };
});
const baseline = readBaseline();
errors.push(...compareBaseline(lane, results, baseline));

if (started) {
  try {
    const guard = { path: "reference/guard.txt", content: "reference" };
    await started.seed(guard.path, guard.content);
    const { description, exec } = await walkthrough(
      started.runner,
      "reference-session",
      guard
    );
    if (exec.exitCode !== 0 || exec.stdout !== guard.content)
      errors.push(`reference client: unexpected exec ${JSON.stringify(exec)}`);
    else
      console.log(
        `reference client: described ${String(description.displayName)}, exec ok`
      );
  } catch (error) {
    errors.push(`reference client: ${(error as Error).message}`);
  } finally {
    await started.close();
  }
}

const green = results.filter((result) => result.ok);
const red = baseline.filter((entry) => entry.lane === lane);
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
