// The checked-in ledgers: known regressions (shrink-only), intended
// differences (each cites an owner decision) and the pin of main.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const directory = "scripts/runner-local-parity/";
export const paths = {
  known: `${directory}known-regressions.json`,
  intended: `${directory}intended-differences.json`,
  pin: `${directory}main-pin.json`,
};

export const readLedger = (name) =>
  JSON.parse(readFileSync(join(root, paths[name]), "utf8"));

const ABSENT = "<absent>";
const place = (entry) =>
  JSON.stringify(
    entry.field ? ["*", entry.field, entry.head] : [entry.scenario, entry.path]
  );
const exact = (entry) => JSON.stringify([place(entry), entry.main, entry.head]);

export function validateLedgers({ known, intended }, scenarioNames) {
  const problems = [];
  const seen = new Set();
  const check = (entry, name, fields) => {
    const label = `${name}: ${entry.scenario} > ${entry.path}`;
    for (const field of fields)
      if (typeof entry[field] !== "string" || !entry[field].trim())
        problems.push(`${label} has no ${field}`);
    if (scenarioNames && !scenarioNames.has(entry.scenario))
      problems.push(`${label} names a scenario that does not exist`);
    if (seen.has(place(entry))) problems.push(`${label} is listed twice`);
    seen.add(place(entry));
  };
  for (const entry of known.entries) {
    if (entry.field) {
      // One entry per added field, wherever that record is returned. It can
      // only excuse an addition: never a changed value or a missing one.
      if (entry.main !== ABSENT || !entry.head || entry.scenario || entry.path)
        problems.push(
          `known: field ${entry.field} may only describe a field main does not have`
        );
      if (seen.has(place(entry)))
        problems.push(`known: field ${entry.field} is listed twice`);
      seen.add(place(entry));
    } else check(entry, "known", ["scenario", "main", "head", "finding"]);
    if (!known.findings[entry.finding]?.task)
      problems.push(`known: finding ${entry.finding} has no owning task`);
  }
  for (const id of Object.keys(known.findings))
    if (!known.entries.some((entry) => entry.finding === id))
      problems.push(`known: finding ${id} has no entries left; delete it`);
  for (const entry of intended) {
    check(entry, "intended", ["scenario", "main", "head", "decision"]);
    if (!/^(D[1-6]|Owner \d{4}-\d\d-\d\d):/.test(entry.decision ?? ""))
      problems.push(
        `intended: ${entry.scenario} must cite an owner decision (D1-D6, or "Owner <date>:")`
      );
  }
  return problems;
}

/** Every difference must match one entry exactly, and every entry one difference. */
export function evaluate(found, { known, intended }, ran, complete = true) {
  const index = (entries) =>
    new Map(
      entries
        .filter((entry) => ran.has(entry.scenario))
        .map((entry) => [exact(entry), entry])
    );
  const knownLeft = index(known.entries);
  const intendedLeft = index(intended);
  const fields = known.entries.filter((entry) => entry.field);
  const fieldsSeen = new Set();
  const result = { known: [], intended: [], unexpected: [] };
  for (const item of found) {
    const id = exact(item);
    if (knownLeft.has(id)) {
      result.known.push(knownLeft.get(id));
      knownLeft.delete(id);
    } else if (intendedLeft.has(id)) {
      result.intended.push(intendedLeft.get(id));
      intendedLeft.delete(id);
    } else {
      const field = fields.find(
        (entry) =>
          item.main === entry.main &&
          item.head === entry.head &&
          item.path.split(" > ").at(-1) === entry.field
      );
      if (!field) {
        result.unexpected.push(item);
        continue;
      }
      result.known.push({ ...item, finding: field.finding });
      fieldsSeen.add(field);
    }
  }
  result.stale = [...knownLeft.values(), ...intendedLeft.values()];
  // Only a whole run can say that a field entry matches nothing.
  if (complete)
    result.stale.push(...fields.filter((entry) => !fieldsSeen.has(entry)));
  return result;
}

/**
 * The set may only shrink, and a different value at a known path is a new
 * regression. A merge that moves the pin changes both columns, so in that
 * commit alone an entry is its scenario and path.
 */
export function assertShrinks(previous, next, pinMoved = false) {
  const id = pinMoved ? place : exact;
  const before = new Set(previous.entries.map(id));
  const after = new Set(next.entries.map(id));
  const added = next.entries.filter((entry) => !before.has(id(entry)));
  // A fix can make a scenario run further, and a difference already tracked
  // under another finding then shows in its output. That may replace the fixed
  // entries of the same scenario, if it is attributed to a finding the ledger
  // already has and the ledger ends up smaller.
  const fixed = new Set(
    previous.entries
      .filter((entry) => !after.has(id(entry)))
      .map((entry) => entry.scenario)
  );
  const surfaced = (entry) =>
    next.entries.length < previous.entries.length &&
    !entry.field &&
    fixed.has(entry.scenario) &&
    previous.entries.some(
      (old) => old.finding === entry.finding && old.scenario !== entry.scenario
    );
  const refused = added.filter((entry) => !surfaced(entry));
  if (refused.length)
    throw new Error(
      `Known parity regressions only shrink. New or changed entries:\n${refused
        .map((entry) => `  ${label(entry)}`)
        .join("\n")}`
    );
}

export const label = (entry) =>
  entry.field
    ? `(every scenario) > ${entry.field}`
    : `${entry.scenario} > ${entry.path}`;

const git = (args, cwd = root) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function at(ref, name, cwd) {
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
  } catch {
    throw new Error(`Cannot read ${ref} to check the parity ledgers`);
  }
  if (!git(["ls-tree", "--name-only", ref, "--", paths[name]], cwd))
    return null;
  return JSON.parse(git(["show", `${ref}:${paths[name]}`], cwd));
}

function isAncestor(older, newer, cwd) {
  try {
    git(["merge-base", "--is-ancestor", older, newer], cwd);
    return true;
  } catch {
    return false;
  }
}

function checkPinMove(previous, next, mergedParents, cwd) {
  if (
    !mergedParents.includes(next) ||
    !isAncestor(previous, next, cwd) ||
    previous === next
  )
    throw new Error(
      `The parity pin moves only forward, in the commit that merges that main commit (${previous.slice(0, 12)} to ${next.slice(0, 12)}).`
    );
}

/** The working tree against HEAD, as it would be committed. */
export function checkWorkingTree(cwd = root) {
  const read = (name) =>
    JSON.parse(readFileSync(join(cwd, paths[name]), "utf8"));
  const pin = read("pin");
  if (!/^[0-9a-f]{40}$/.test(pin.sha))
    throw new Error("The parity pin must be a full commit sha");
  let merging = [];
  try {
    merging = [git(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], cwd)];
  } catch {
    // Not in the middle of a merge.
  }
  const oldPin = at("HEAD", "pin", cwd);
  const moved = Boolean(oldPin && oldPin.sha !== pin.sha);
  if (moved) checkPinMove(oldPin.sha, pin.sha, merging, cwd);
  if (![...merging, "HEAD"].some((ref) => isAncestor(pin.sha, ref, cwd)))
    throw new Error("The parity pin is not part of this branch");
  const old = at("HEAD", "known", cwd);
  if (old) assertShrinks(old, read("known"), moved);
}

/** CI: every commit in base..head that touches a ledger. */
export function checkHistory(base, head, cwd = root) {
  const commits = git(
    [
      "rev-list",
      "--reverse",
      "--first-parent",
      `${base}..${head}`,
      "--",
      paths.known,
      paths.pin,
    ],
    cwd
  )
    .split("\n")
    .filter(Boolean);
  for (const commit of commits) {
    const [parent, ...merged] = git(
      ["rev-list", "--parents", "-n", "1", commit],
      cwd
    )
      .split(" ")
      .slice(1);
    if (!parent) continue;
    const oldPin = at(parent, "pin", cwd);
    const pin = at(commit, "pin", cwd);
    const old = at(parent, "known", cwd);
    const known = at(commit, "known", cwd);
    // A branch that already carried the ledgers may never drop them.
    if ((old && !known) || (oldPin && !pin))
      throw new Error(`${commit.slice(0, 12)} deletes a parity ledger`);
    const moved = Boolean(oldPin && pin && oldPin.sha !== pin.sha);
    if (moved) checkPinMove(oldPin.sha, pin.sha, merged, cwd);
    if (old) assertShrinks(old, known, moved);
  }
  const pin = at(head, "pin", cwd);
  if (pin && !isAncestor(pin.sha, head, cwd))
    throw new Error("The parity pin is not part of this branch");
}
