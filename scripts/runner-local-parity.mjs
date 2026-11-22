// Local parity against main (design E7). Local users must see no change.
//
// Builds main at the pinned commit and the head, drives both through the same
// scenarios on isolated databases and state roots, and fails on any difference
// that is not an exact entry in one of the two checked-in ledgers.
//
//   DISPATCH_PARITY_DATABASE_URL=postgres://… pnpm run parity:local
//     --only <regexp>    some scenarios only
//     --head <ref>       test a commit instead of the working tree
//     --control          main against main, which must find nothing
//     --jobs <n>         scenarios at once (default 3)
//     --output <dir>     write report.md and report.json
//   node scripts/runner-local-parity.mjs --history <base> <head>
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildSide } from "./runner-local-parity/build.mjs";
import {
  differences,
  normaliseObserved,
} from "./runner-local-parity/compare.mjs";
import {
  checkHistory,
  checkWorkingTree,
  evaluate,
  readLedger,
  validateLedgers,
} from "./runner-local-parity/ledger.mjs";
import { report } from "./runner-local-parity/report.mjs";
import { scenarios } from "./runner-local-parity/scenarios/index.mjs";
import {
  killUnder,
  prepareTools,
  World,
} from "./runner-local-parity/world.mjs";

async function inBatches(items, size, work) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (let item = queue.shift(); item; item = queue.shift())
        await work(item);
    })
  );
}

function databaseUrl() {
  // Deliberately never DATABASE_URL: that may be somebody's real database.
  const value =
    process.env.DISPATCH_PARITY_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!value)
    throw new Error(
      "Set DISPATCH_PARITY_DATABASE_URL (or TEST_DATABASE_URL) to a scratch Postgres server. The oracle creates and drops its own databases there."
    );
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The parity database URL is not a URL");
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("The parity database must be on loopback");
  if (url.pathname.replace(/^\/+/, "") === "dispatch")
    throw new Error(
      "Connect through a maintenance database (postgres), never 'dispatch'"
    );
  return value;
}

async function main() {
  if (process.argv[2] === "--history") {
    const [base, head] = process.argv.slice(3);
    if (!base || !head) throw new Error("--history needs <base> <head>");
    checkHistory(base, head);
    console.log("Local parity ledgers only shrink.");
    return;
  }
  const { values } = parseArgs({
    options: {
      only: { type: "string" },
      head: { type: "string" },
      control: { type: "boolean", default: false },
      // More at once starves main's 800ms Git probes, and saves nothing: one
      // scenario waits five minutes anyway.
      jobs: { type: "string", default: "3" },
      output: { type: "string" },
    },
  });
  if (values.control && values.head)
    throw new Error("--control and --head cannot be combined");
  const jobs = Number(values.jobs);
  if (!Number.isInteger(jobs) || jobs < 1)
    throw new Error("--jobs needs a positive integer");

  const ledgers = {
    known: readLedger("known"),
    intended: readLedger("intended"),
  };
  const names = new Set(scenarios.map((scenario) => scenario.name));
  if (names.size !== scenarios.length)
    throw new Error("Two parity scenarios share a name");
  const invalid = validateLedgers(ledgers, names);
  if (invalid.length) throw new Error(invalid.join("\n"));
  if (!values.head && !values.control) checkWorkingTree();

  const adminUrl = databaseUrl();
  const filter = values.only && new RegExp(values.only);
  const chosen = scenarios.filter(
    (scenario) => !filter || filter.test(scenario.name)
  );
  const runnable = chosen.filter((scenario) => !scenario.skip);
  if (!runnable.length) throw new Error("No scenario matched");

  const started = Date.now();
  const runId = randomBytes(4).toString("hex");
  // Short and canonical: a host's socket path must stay under 104 bytes.
  const root = realpathSync(mkdtempSync("/tmp/dp-"));
  const worlds = new Set();
  const builds = new AbortController();
  let interrupted = false;
  const interrupt = (signal) => {
    if (interrupted) return;
    interrupted = true;
    console.error(`${signal}: cleaning up`);
    builds.abort();
    void Promise.allSettled([...worlds].map((world) => world.dispose()))
      .then(() => {
        killUnder(`${root}/`);
        rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      })
      .finally(() => process.exit(130));
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);

  try {
    console.log("Building main and the head…");
    const pinned = await buildSide({
      name: "main",
      ref: readLedger("pin").sha,
      root,
      signal: builds.signal,
    });
    const built = {
      main: pinned,
      head: values.control
        ? pinned
        : await buildSide({
            name: "head",
            ref: values.head,
            root,
            signal: builds.signal,
          }),
    };
    const tools = prepareTools(root);
    console.log(
      `main ${built.main.commit.slice(0, 12)} / head ${built.head.commit.slice(0, 12)}${values.head || values.control ? "" : " plus the working tree"}: ${runnable.length} scenarios`
    );

    const results = [];
    const failures = [];
    const runScenario = async (scenario) => {
      if (interrupted) return;
      const index = String(scenarios.indexOf(scenario)).padStart(2, "0");
      const began = Date.now();
      const observe = async (side) => {
        // Equal-length paths on both sides keep byte counts comparable.
        const directory = join(root, index, side[0]);
        mkdirSync(directory, { recursive: true });
        const world = new World({
          side,
          directory,
          database: `dispatch_parity_${runId}_${index}_${side}`,
          adminUrl,
          tools,
          builds: built,
        });
        worlds.add(world);
        try {
          await world.prepare();
          if (!scenario.manualStart) await world.start();
          await scenario.run(world);
          return normaliseObserved(world.observed, await world.bindings());
        } catch (error) {
          failures.push({
            scenario: scenario.name,
            side,
            error: world.redact(error.stack ?? String(error)),
            log: world.logTail(),
          });
          return undefined;
        } finally {
          const problems = await world.dispose();
          worlds.delete(world);
          if (problems.length)
            failures.push({
              scenario: scenario.name,
              side,
              error: `Cleanup failed: ${problems.join("; ")}`,
            });
        }
      };
      const [main, head] = await Promise.all([
        observe("main"),
        observe("head"),
      ]);
      const found =
        main === undefined || head === undefined
          ? []
          : differences(main, head).map((item) => ({
              scenario: scenario.name,
              ...item,
            }));
      results.push({
        name: scenario.name,
        seconds: Math.round((Date.now() - began) / 1000),
        completed: main !== undefined && head !== undefined,
        found,
        main,
        head,
      });
      console.log(
        `  ${scenario.name}: ${main === undefined || head === undefined ? "failed to run" : found.length ? `${found.length} differences` : "same"}`
      );
    };
    // A scenario that only waits for a real timeout has a lane of its own.
    await Promise.all([
      inBatches(
        runnable.filter((scenario) => !scenario.waits),
        jobs,
        runScenario
      ),
      ...runnable.filter((scenario) => scenario.waits).map(runScenario),
    ]);
    if (interrupted) return;
    results.sort(
      (a, b) =>
        scenarios.findIndex((item) => item.name === a.name) -
        scenarios.findIndex((item) => item.name === b.name)
    );

    const ran = new Set(
      results.filter((item) => item.completed).map((item) => item.name)
    );
    const outcome = evaluate(
      results.flatMap((item) => item.found),
      values.control ? { known: { entries: [] }, intended: [] } : ledgers,
      ran,
      !filter && !values.control
    );
    const summary = {
      mode: values.control ? "control" : "parity",
      main: built.main.commit,
      head: built.head.commit,
      workingTree: !values.head && !values.control,
      seconds: Math.round((Date.now() - started) / 1000),
      complete: !filter,
      findings: ledgers.known.findings,
      scenarios: chosen.map(({ name, title, skip }) => ({ name, title, skip })),
      results,
      failures,
      ...outcome,
    };
    const { markdown, passed } = report(summary);
    console.log(markdown);
    if (values.output) {
      const directory = resolve(values.output);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "report.md"), markdown);
      writeFileSync(
        join(directory, "report.json"),
        `${JSON.stringify(summary, null, 2)}\n`
      );
    }
    if (!passed) process.exitCode = 1;
  } finally {
    if (!interrupted) {
      try {
        killUnder(`${root}/`);
      } finally {
        rmSync(root, { recursive: true, force: true, maxRetries: 3 });
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", interrupt);
      }
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
