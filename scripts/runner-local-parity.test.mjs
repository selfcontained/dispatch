// The comparer and the ledgers, without building or running anything.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createNormaliser,
  differences,
  normaliseObserved,
  substitutions,
} from "./runner-local-parity/compare.mjs";
import {
  assertShrinks,
  checkHistory,
  checkWorkingTree,
  evaluate,
  paths,
  readLedger,
  validateLedgers,
} from "./runner-local-parity/ledger.mjs";
import { childProcessEnv } from "../apps/server/src/shared/process/child-environment.js";

test("the substitution list is closed", () => {
  // A new entry hides a kind of difference from every later task. Changing
  // this list is the review point.
  assert.deepEqual(
    substitutions.map((rule) => rule.name),
    [
      "run root",
      "oracle directory",
      "machine",
      "scratch database",
      "build revision",
      "instance secret",
      "loopback port",
      "agent id",
      "uuid",
      "timestamp",
      "file name timestamp",
      "fixture session id",
      "epoch milliseconds",
      "duration",
      "process id",
      "database oid",
      "image change token",
      "checkout state id",
      "checkout state id in text",
      "task and column id",
    ]
  );
});

test("normalisation removes the substitutions and nothing else", () => {
  const normalise = createNormaliser({
    root: ["/private/tmp/dp-x/01/m"],
    secrets: ["s3cret"],
    port: 23456,
    agents: ["agt_aaaaaaaaaaaa"],
  });
  assert.deepEqual(
    normalise({
      path: "/private/tmp/dp-x/01/m/work",
      url: "http://127.0.0.1:23456/api",
      port: 23456,
      other: 23456,
      token: "s3cret",
      agent: "agt_aaaaaaaaaaaa",
      branch: "agent-aaaaaa",
      at: "2026-11-22T11:22:33.123Z",
      updatedAt: 1795372275337,
      size: 1795372275337,
      message: "Session files are limited to 20 MiB.",
    }),
    {
      agent: "<agent:1>",
      at: "<time>",
      branch: "agent-<agent:1>",
      message: "Session files are limited to 20 MiB.",
      other: 23456,
      path: "<root>/work",
      port: "<port>",
      size: 1795372275337,
      token: "<secret>",
      updatedAt: "<epoch-ms>",
      url: "http://127.0.0.1:<port>/api",
    }
  );
});

test("one step cannot renumber another", () => {
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  const observe = (extra) =>
    normaliseObserved(
      {
        ...extra,
        later: { id: second, again: second, child: "agt_cccccccccccc" },
      },
      { agents: ["agt_aaaaaaaaaaaa"] }
    );
  const expected = {
    again: "<uuid:1>",
    child: "<agent:launched-1>",
    id: "<uuid:1>",
  };
  assert.deepEqual(observe({}).later, expected);
  assert.deepEqual(
    observe({ earlier: { id: first, child: "agt_bbbbbbbbbbbb" } }).later,
    expected
  );
});

test("differences see values, absence, types and order", () => {
  assert.deepEqual(differences({ a: [1, 2] }, { a: [1, 2] }), []);
  assert.deepEqual(differences({ a: [1, 2] }, { a: [2, 1] }), [
    { path: "a > 0", main: "1", head: "2" },
    { path: "a > 1", main: "2", head: "1" },
  ]);
  assert.deepEqual(differences({ a: null }, { b: false }), [
    { path: "a", main: "null", head: "<absent>" },
    { path: "b", main: "<absent>", head: "false" },
  ]);
  const [long] = differences("x".repeat(500), `${"x".repeat(499)}y`);
  assert.notEqual(long.main, long.head);
});

const entry = {
  scenario: "sharing",
  path: "post > isError",
  main: "<absent>",
  head: "true",
  finding: "one",
};
const field = {
  field: "added",
  main: "<absent>",
  head: "false",
  finding: "one",
};
const known = (entries) => ({
  findings: { one: { title: "One", task: "F1" } },
  entries,
});

test("only an exact entry excuses a difference", () => {
  const run = (found, entries = [entry]) =>
    evaluate(
      found,
      { known: known(entries), intended: [] },
      new Set(["sharing"])
    );
  assert.equal(run([entry]).unexpected.length, 0);
  assert.equal(run([]).stale.length, 1);
  for (const change of [{ head: "1" }, { main: "false" }, { path: "other" }]) {
    const result = run([{ ...entry, ...change }]);
    assert.equal(result.unexpected.length, 1);
    assert.equal(result.stale.length, 1);
  }
});

test("a field entry excuses that added field and value only", () => {
  const run = (found, complete = true) =>
    evaluate(
      found,
      { known: known([field]), intended: [] },
      new Set(["sharing"]),
      complete
    );
  const added = {
    scenario: "sharing",
    path: "agent > added",
    main: "<absent>",
    head: "false",
  };
  assert.equal(run([added]).known.length, 1);
  for (const change of [
    { head: "true" },
    { main: "true" },
    { path: "agent > other" },
  ])
    assert.equal(run([{ ...added, ...change }]).unexpected.length, 1);
  assert.equal(run([]).stale.length, 1);
  assert.equal(run([], false).stale.length, 0);
});

test("known regressions only shrink", () => {
  const other = { ...entry, path: "post > text" };
  assertShrinks(known([entry, other]), known([entry]));
  for (const next of [
    [entry, other],
    [other],
    [{ ...entry, head: "1" }],
    [{ ...entry, main: "false" }],
    [field],
  ])
    assert.throws(() => assertShrinks(known([entry]), known(next)), /shrink/);
  assertShrinks(
    known([entry]),
    known([{ ...entry, main: "false", head: "1" }]),
    true
  );
});

test("a fix may swap its entries for a known difference it uncovers, if the ledger shrinks", () => {
  const fixed = { ...entry, scenario: "fixed", finding: "fixed-finding" };
  const fixedToo = { ...fixed, path: "post > more" };
  const tracked = { ...entry, scenario: "elsewhere", finding: "tracked" };
  const surfaced = {
    ...entry,
    scenario: "fixed",
    path: "plan",
    finding: "tracked",
  };
  const ledger = (entries) => ({
    findings: {
      "fixed-finding": { title: "f", task: "T" },
      tracked: { title: "t", task: "T" },
    },
    entries,
  });
  const before = ledger([fixed, fixedToo, tracked]);
  assertShrinks(before, ledger([tracked, surfaced]));
  for (const next of [
    // No net shrink.
    [fixed, tracked, surfaced],
    // A scenario nothing was fixed in.
    [tracked, { ...surfaced, scenario: "other" }],
    // A finding the ledger did not have.
    [tracked, { ...surfaced, finding: "new" }],
    // A finding only this scenario had.
    [tracked, { ...surfaced, finding: "fixed-finding" }],
  ])
    assert.throws(() => assertShrinks(before, ledger(next)), /shrink/);
});

test("ledger entries need an owner", () => {
  const problems = (ledgers) =>
    validateLedgers(
      { known: known([]), intended: [], ...ledgers },
      new Set(["sharing"])
    ).join("\n");
  assert.match(
    problems({ known: known([{ ...field, main: "true" }]) }),
    /may only describe/
  );
  assert.match(
    problems({
      known: known([entry]),
      intended: [{ ...entry, path: "x", decision: "seems fine" }],
    }),
    /owner decision/
  );
});

test("the checked-in ledgers are valid", () => {
  assert.deepEqual(
    validateLedgers({
      known: readLedger("known"),
      intended: readLedger("intended"),
    }),
    []
  );
});

function scratchRepository(t) {
  const root = mkdtempSync(join(tmpdir(), "dispatch-parity-ledger-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...childProcessEnv(),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Parity",
        GIT_AUTHOR_EMAIL: "parity@example.invalid",
        GIT_COMMITTER_NAME: "Parity",
        GIT_COMMITTER_EMAIL: "parity@example.invalid",
      },
    }).trim();
  mkdirSync(join(root, "scripts/runner-local-parity"), { recursive: true });
  const write = (name, value) =>
    writeFileSync(join(root, paths[name]), JSON.stringify(value));
  const commit = (message) => {
    git("add", "--all");
    git("commit", "--quiet", "--allow-empty", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "--quiet", "--initial-branch=main");
  const base = commit("Base");
  git("switch", "--quiet", "-c", "branch");
  write("pin", { sha: base });
  write("known", known([entry]));
  write("intended", []);
  commit("Seed");
  return { root, git, write, commit, base };
}

test("history rejects growth, even if a later commit undoes it", (t) => {
  const { root, write, commit, base } = scratchRepository(t);
  write("known", known([entry, { ...entry, path: "post > text" }]));
  assert.throws(() => checkWorkingTree(root), /shrink/);
  commit("Grow");
  write("known", known([entry]));
  const head = commit("Undo");
  assert.throws(() => checkHistory(base, head, root), /shrink/);
});

test("the pin moves only in the merge of that main commit", (t) => {
  const { root, git, write, commit, base } = scratchRepository(t);
  git("switch", "--quiet", "main");
  const next = commit("Main moves");
  git("switch", "--quiet", "branch");

  write("pin", { sha: next });
  assert.throws(() => checkWorkingTree(root), /pin moves/);
  const bad = commit("Move the pin alone");
  assert.throws(() => checkHistory(base, bad, root), /pin moves/);
  git("reset", "--quiet", "--hard", "HEAD~1");

  git("merge", "--quiet", "--no-ff", "--no-commit", "main");
  write("pin", { sha: next });
  checkWorkingTree(root);
  const merged = commit("Merge main");
  checkHistory(base, merged, root);
});
