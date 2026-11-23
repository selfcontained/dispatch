#!/usr/bin/env node
// Bounded retention for the generated data builders leave behind on this
// host: Playwright browser revisions, Playwright MCP browser profiles and the
// Bun runtime transpiler cache. Dry run by default; pass --apply to delete.
//
// It never touches worktrees, dependency stores, Claude session scratch or
// anything outside the three cache roots below, and it keeps:
//   - every browser revision a live Playwright install still references
//     (the same rule `playwright install` uses for its own cleanup);
//   - every MCP profile, unless --include-mcp-profiles is passed (profiles
//     can hold signed-in session state, so age alone never removes one);
//     with it, profiles whose workspace still exists, that are locked by a
//     running browser, or were used within --mcp-days are still kept;
//   - every Bun transpiler entry read or written within --bun-days.
//
// Symlinked entries are never followed or deleted through.
//
// Usage: node scripts/prune-builder-caches.mjs [--apply] [--json]
//          [--include-mcp-profiles] [--mcp-days 30] [--bun-days 14]
//          [--keep-path <dir>]...
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const DAY_MS = 24 * 60 * 60 * 1000;

const { values: args } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    "include-mcp-profiles": { type: "boolean", default: false },
    "mcp-days": { type: "string", default: "30" },
    "bun-days": { type: "string", default: "14" },
    "keep-path": { type: "string", multiple: true, default: [] },
    "playwright-dir": { type: "string" },
    "mcp-dir": { type: "string" },
    "bun-dir": { type: "string" },
  },
});

const home = os.homedir();
const caches = path.join(home, "Library", "Caches");
const roots = {
  playwright:
    args["playwright-dir"] ??
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    path.join(caches, "ms-playwright"),
  mcp: args["mcp-dir"] ?? path.join(caches, "ms-playwright-mcp"),
  bun:
    args["bun-dir"] ??
    process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH ??
    path.join(caches, "bun"),
};
const now = Date.now();
const mcpDays = Number(args["mcp-days"]);
const bunDays = Number(args["bun-days"]);
if (!(mcpDays >= 1) || !(bunDays >= 1)) {
  console.error("--mcp-days and --bun-days must be at least 1.");
  process.exit(2);
}

/** Resolve a cache root through its symlink; null when its drive is absent. */
function resolveRoot(dir) {
  try {
    return realpathSync(dir);
  } catch {
    return null;
  }
}

function sizeKiB(target) {
  try {
    return Number(
      execFileSync("du", ["-sk", target], { encoding: "utf8" }).split("\t")[0]
    );
  } catch {
    return 0;
  }
}

/**
 * Last write to a directory, or to the first of `markers` inside it that
 * exists. Directory atime is not used: listing a folder bumps it.
 */
function lastWrite(target, markers = []) {
  for (const marker of markers) {
    try {
      return statSync(path.join(target, marker)).mtimeMs;
    } catch {
      // Try the next marker.
    }
  }
  return statSync(target).mtimeMs;
}

const candidates = [];
const kept = [];

// --- Playwright browser revisions -------------------------------------------
/**
 * An install path whose drive is not mounted is unreachable, not retired:
 * its browsers are still needed once the drive is back.
 */
function onAbsentVolume(target) {
  const match = /^\/Volumes\/[^/]+/.exec(target);
  return Boolean(match) && !existsSync(match[0]);
}

function playwrightRevisions(root) {
  const linksDir = path.join(root, ".links");
  const required = new Set();
  const liveInstalls = [];
  const unreachable = [];
  for (const link of existsSync(linksDir) ? readdirSync(linksDir) : []) {
    const install = readFileSync(path.join(linksDir, link), "utf8").trim();
    const browsersJson = path.join(install, "browsers.json");
    if (!existsSync(browsersJson)) {
      if (onAbsentVolume(install)) unreachable.push(install);
      continue;
    }
    let browsers;
    try {
      ({ browsers } = JSON.parse(readFileSync(browsersJson, "utf8")));
    } catch {
      unreachable.push(install);
      continue;
    }
    liveInstalls.push(install);
    for (const browser of browsers) {
      const dirName = browser.name.replace(/-/g, "_");
      for (const revision of [
        browser.revision,
        ...Object.values(browser.revisionOverrides ?? {}),
      ]) {
        required.add(`${dirName}-${revision}`);
      }
    }
  }
  // Without a complete picture of what is needed, delete nothing.
  const holdAll =
    unreachable.length > 0
      ? `install unreachable: ${unreachable[0]}`
      : liveInstalls.length === 0
        ? "no live Playwright install found"
        : null;
  if (holdAll) console.error(`keep all browser revisions (${holdAll})`);
  for (const entry of readdirSync(root)) {
    // Only revision folders (chromium-1208, ffmpeg-1011…); `.links` and the
    // session registry `b/` belong to Playwright itself.
    if (!/^[a-z_]+-\d+$/.test(entry)) continue;
    const target = path.join(root, entry);
    if (!lstatSync(target).isDirectory()) continue;
    // A revision being downloaded right now has no link yet.
    const recent = now - lastWrite(target) < DAY_MS;
    if (holdAll || required.has(entry) || recent) {
      kept.push({
        kind: "playwright-browser",
        path: target,
        reason:
          holdAll ??
          (required.has(entry) ? "referenced" : "used in the last day"),
      });
    } else {
      candidates.push({
        kind: "playwright-browser",
        path: target,
        reason: "no live Playwright install references it",
      });
    }
  }
  return liveInstalls.length;
}

// --- Playwright MCP profiles ------------------------------------------------
function workspacePaths() {
  const paths = new Set(args["keep-path"].map((p) => path.resolve(p)));
  for (const repo of [process.cwd(), ...args["keep-path"]]) {
    try {
      const out = execFileSync(
        "git",
        ["-C", repo, "worktree", "list", "--porcelain"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      );
      for (const line of out.split("\n")) {
        if (line.startsWith("worktree ")) paths.add(line.slice(9));
      }
    } catch {
      // Not a repository; the path itself is still kept.
    }
  }
  return paths;
}

function profileLocked(profile) {
  try {
    const lock = readlinkSync(path.join(profile, "SingletonLock"));
    const pid = Number(lock.split("-").pop());
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function mcpProfiles(root) {
  const liveHashes = new Map();
  for (const workspace of workspacePaths()) {
    liveHashes.set(
      createHash("sha256").update(workspace).digest("hex").slice(0, 7),
      workspace
    );
  }
  for (const entry of readdirSync(root)) {
    const match = /^mcp-.+-([0-9a-f]{7})$/.exec(entry);
    if (!match) continue;
    const target = path.join(root, entry);
    if (!lstatSync(target).isDirectory()) continue;
    const workspace = liveHashes.get(match[1]);
    const ageDays =
      (now - lastWrite(target, ["Local State", "Default/Preferences"])) /
      DAY_MS;
    if (workspace) {
      kept.push({
        kind: "mcp-profile",
        path: target,
        reason: `workspace ${workspace}`,
      });
    } else if (profileLocked(target)) {
      kept.push({
        kind: "mcp-profile",
        path: target,
        reason: "browser running",
      });
    } else if (ageDays < mcpDays) {
      kept.push({
        kind: "mcp-profile",
        path: target,
        reason: `used ${ageDays.toFixed(0)}d ago`,
      });
    } else if (!args["include-mcp-profiles"]) {
      kept.push({
        kind: "mcp-profile",
        path: target,
        reason: `unused ${ageDays.toFixed(0)}d, workspace gone; pass --include-mcp-profiles to remove`,
      });
    } else {
      candidates.push({
        kind: "mcp-profile",
        path: target,
        reason: `unused ${ageDays.toFixed(0)}d, workspace gone`,
      });
    }
  }
}

// --- Bun runtime transpiler cache -------------------------------------------
function bunTranspiler(root) {
  let files = 0;
  let stale = 0;
  let staleBytes = 0;
  const staleFiles = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile()) {
        files += 1;
        const info = statSync(target);
        if (now - Math.max(info.mtimeMs, info.atimeMs) > bunDays * DAY_MS) {
          stale += 1;
          staleBytes += info.blocks * 512;
          staleFiles.push(target);
        }
      }
    }
  };
  walk(root);
  if (stale > 0) {
    candidates.push({
      kind: "bun-transpiler",
      path: root,
      reason: `${stale} of ${files} entries untouched ${bunDays}d`,
      files: staleFiles,
      kib: Math.round(staleBytes / 1024),
    });
  }
}

const report = { roots: {}, liveInstalls: 0 };
for (const [name, dir] of Object.entries(roots)) {
  const resolved = resolveRoot(dir);
  report.roots[name] = { configured: dir, resolved };
  if (!resolved) {
    console.error(`skip ${name}: ${dir} is unavailable (drive not connected?)`);
    continue;
  }
  if (name === "playwright")
    report.liveInstalls = playwrightRevisions(resolved);
  if (name === "mcp") mcpProfiles(resolved);
  if (name === "bun") bunTranspiler(resolved);
}

let totalKiB = 0;
for (const item of candidates) {
  item.kib ??= sizeKiB(item.path);
  totalKiB += item.kib;
  if (args.apply) {
    for (const target of item.files ?? [item.path]) {
      rmSync(target, { recursive: true, force: true });
    }
  }
  delete item.files;
}

if (args.json) {
  console.log(
    JSON.stringify(
      { ...report, apply: args.apply, candidates, kept, totalKiB },
      null,
      2
    )
  );
} else {
  for (const item of kept)
    console.log(`keep    ${item.kind}  ${item.path}  (${item.reason})`);
  for (const item of candidates) {
    console.log(
      `${args.apply ? "removed" : "would rm"} ${item.kind}  ${item.path}  ${(item.kib / 1048576).toFixed(2)} GiB  (${item.reason})`
    );
  }
  console.log(
    `${args.apply ? "Removed" : "Would remove"} ${(totalKiB / 1048576).toFixed(2)} GiB across ${candidates.length} item(s); ${report.liveInstalls} live Playwright install(s).${args.apply ? "" : " Dry run: pass --apply to delete."}`
  );
}
