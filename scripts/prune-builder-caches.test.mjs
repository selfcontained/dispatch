import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "prune-builder-caches.mjs"
);
const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "prune-caches-"));
  const pw = path.join(root, "ms-playwright");
  const mcp = path.join(root, "ms-playwright-mcp");
  const bun = path.join(root, "bun");
  const install = path.join(root, "install", "playwright-core");
  const workspace = path.join(root, "workspace");
  for (const dir of [
    pw,
    mcp,
    bun,
    install,
    workspace,
    path.join(pw, ".links"),
    path.join(pw, "b"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(
    path.join(install, "browsers.json"),
    JSON.stringify({
      browsers: [
        { name: "chromium-headless-shell", revision: "1208" },
        {
          name: "webkit",
          revision: "2248",
          revisionOverrides: { mac14: "2251" },
        },
      ],
    })
  );
  writeFileSync(path.join(pw, ".links", "live"), install);
  writeFileSync(path.join(pw, ".links", "dead"), path.join(root, "gone"));
  const revisions = [
    "chromium_headless_shell-1208",
    "webkit-2251",
    "chromium-1100",
  ];
  for (const name of revisions) {
    mkdirSync(path.join(pw, name));
    utimesSync(path.join(pw, name), old, old);
  }
  const hash = (p) => createHash("sha256").update(p).digest("hex").slice(0, 7);
  for (const name of [`mcp-chrome-${hash(workspace)}`, "mcp-chrome-0000000"]) {
    mkdirSync(path.join(mcp, name));
    writeFileSync(path.join(mcp, name, "Local State"), "{}");
    utimesSync(path.join(mcp, name, "Local State"), old, old);
  }
  writeFileSync(path.join(bun, "stale.pile"), "x");
  utimesSync(path.join(bun, "stale.pile"), old, old);
  writeFileSync(path.join(bun, "fresh.pile"), "x");
  const run = (...extra) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          script,
          "--json",
          "--playwright-dir",
          pw,
          "--mcp-dir",
          mcp,
          "--bun-dir",
          bun,
          "--keep-path",
          workspace,
          ...extra,
        ],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      )
    );
  return { root, pw, mcp, bun, workspace, hash, run };
}

test("dry run lists only unreferenced, unused, stale data", () => {
  const f = fixture();
  try {
    const result = f.run("--include-mcp-profiles");
    assert.equal(result.apply, false);
    assert.deepEqual(
      result.candidates.map((c) => path.basename(c.path)).sort(),
      ["bun", "chromium-1100", "mcp-chrome-0000000"]
    );
    assert.ok(existsSync(path.join(f.pw, "chromium-1100")));
    assert.ok(existsSync(path.join(f.bun, "stale.pile")));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("apply keeps MCP profiles unless they are opted in", () => {
  const f = fixture();
  try {
    const result = f.run("--apply");
    assert.ok(existsSync(path.join(f.mcp, "mcp-chrome-0000000")));
    assert.ok(
      result.kept.some((k) => k.reason.includes("pass --include-mcp-profiles"))
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("apply removes candidates and keeps required revisions and live profiles", () => {
  const f = fixture();
  try {
    f.run("--apply", "--include-mcp-profiles");
    assert.equal(existsSync(path.join(f.pw, "chromium-1100")), false);
    assert.ok(existsSync(path.join(f.pw, "chromium_headless_shell-1208")));
    assert.ok(
      existsSync(path.join(f.pw, "webkit-2251")),
      "platform override kept"
    );
    assert.ok(existsSync(path.join(f.pw, "b")), "session registry untouched");
    assert.ok(
      existsSync(path.join(f.mcp, `mcp-chrome-${f.hash(f.workspace)}`))
    );
    assert.equal(existsSync(path.join(f.mcp, "mcp-chrome-0000000")), false);
    assert.equal(existsSync(path.join(f.bun, "stale.pile")), false);
    assert.ok(existsSync(path.join(f.bun, "fresh.pile")));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("revisions are all kept when a linked install is on an absent drive", () => {
  const f = fixture();
  try {
    writeFileSync(
      path.join(f.pw, ".links", "unmounted"),
      "/Volumes/dispatch-test-absent-drive/repo/node_modules/playwright-core"
    );
    const result = f.run("--apply");
    assert.ok(existsSync(path.join(f.pw, "chromium-1100")));
    assert.ok(
      result.kept.some((k) => k.reason.startsWith("install unreachable"))
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("revisions are all kept when no live install is found", () => {
  const f = fixture();
  try {
    rmSync(path.join(f.pw, ".links"), { recursive: true });
    f.run("--apply");
    assert.ok(existsSync(path.join(f.pw, "chromium-1100")));
    assert.ok(existsSync(path.join(f.pw, "chromium_headless_shell-1208")));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a second install's revision is kept too", () => {
  const f = fixture();
  try {
    const other = path.join(f.root, "other", "playwright-core");
    mkdirSync(other, { recursive: true });
    writeFileSync(
      path.join(other, "browsers.json"),
      JSON.stringify({ browsers: [{ name: "chromium", revision: "1100" }] })
    );
    writeFileSync(path.join(f.pw, ".links", "other"), other);
    f.run("--apply");
    assert.ok(existsSync(path.join(f.pw, "chromium-1100")));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("symlinked entries are never followed or deleted through", () => {
  const f = fixture();
  try {
    const outside = path.join(f.root, "outside");
    mkdirSync(path.join(outside, "dir"), { recursive: true });
    writeFileSync(path.join(outside, "dir", "keep"), "x");
    writeFileSync(path.join(outside, "old.pile"), "x");
    utimesSync(path.join(outside, "old.pile"), old, old);
    utimesSync(path.join(outside, "dir"), old, old);
    symlinkSync(path.join(outside, "dir"), path.join(f.pw, "chromium-1000"));
    symlinkSync(
      path.join(outside, "dir"),
      path.join(f.mcp, "mcp-chrome-1111111")
    );
    symlinkSync(path.join(outside, "old.pile"), path.join(f.bun, "link.pile"));
    f.run("--apply", "--include-mcp-profiles");
    assert.ok(existsSync(path.join(outside, "dir", "keep")));
    assert.ok(existsSync(path.join(outside, "old.pile")));
    assert.ok(existsSync(path.join(f.pw, "chromium-1000")));
    assert.ok(existsSync(path.join(f.mcp, "mcp-chrome-1111111")));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("an unavailable cache root is skipped, not created", () => {
  const f = fixture();
  try {
    const missing = path.join(f.root, "unmounted", "ms-playwright");
    const result = f.run("--playwright-dir", missing);
    assert.equal(result.roots.playwright.resolved, null);
    assert.equal(existsSync(path.join(f.root, "unmounted")), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
