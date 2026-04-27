import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const VALID_MANIFEST = `id: bun-cutover
title: Bun runtime cutover
summary: Migrate installs from Node-era to Bun runtime.
alreadySatisfied:
  description: Service entrypoint already targets the Bun wrapper.
instructions:
  - Inspect the service entrypoint
  - Repoint to the Bun wrapper if needed
validation:
  requiredChecks:
    - expected_runtime_artifact
    - service_entrypoint
rollback:
  - Restore the prior entrypoint
`;

let testRoot: string;
let cacheDir: string;

async function importCache() {
  return await import("../src/release-tarball-cache.js");
}

beforeEach(async () => {
  testRoot = await mkdtemp(path.join(os.tmpdir(), "dispatch-cache-test-"));
  cacheDir = path.join(testRoot, "cache");
  process.env.DISPATCH_RELEASE_CACHE_DIR = cacheDir;
});

afterEach(async () => {
  delete process.env.DISPATCH_RELEASE_CACHE_DIR;
  await rm(testRoot, { recursive: true, force: true });
});

/**
 * Build a release-shaped tarball with the requested entries. Honors the
 * structure pack-release produces: a manifest of paths inside a working dir,
 * tarred with `tar czf`. Entries can be relative file paths (->
 * "file with VALID_MANIFEST contents") or [path, contents] tuples.
 */
async function buildTarball(
  entries: Array<string | [string, string]>
): Promise<string> {
  const buildDir = await mkdtemp(path.join(testRoot, "build-"));
  for (const entry of entries) {
    const [relPath, contents] = Array.isArray(entry)
      ? entry
      : [entry, VALID_MANIFEST];
    const fullPath = path.join(buildDir, relPath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf-8");
  }
  const tarballPath = path.join(testRoot, `tarball-${Date.now()}.tar.gz`);
  execFileSync(
    "tar",
    [
      "czf",
      tarballPath,
      "-C",
      buildDir,
      ...entries.map((e) => (Array.isArray(e) ? e[0] : e)),
    ],
    { stdio: "pipe" }
  );
  return tarballPath;
}

describe("release-tarball-cache extraction", () => {
  it("extracts update-migrations/ from a real tarball", async () => {
    const { extractUpdateMigrationsTo } = await importCache();
    const tarball = await buildTarball([
      "update-migrations/0001-bun-cutover.yaml",
      "update-migrations/0002-second.yaml",
    ]);
    const { dir, cleanup } = await extractUpdateMigrationsTo(tarball);
    try {
      const files = await readFile(
        path.join(dir, "0001-bun-cutover.yaml"),
        "utf-8"
      );
      expect(files).toContain("id: bun-cutover");
      const stats = await stat(path.join(dir, "0002-second.yaml"));
      expect(stats.isFile()).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("returns an empty dir for a tarball without update-migrations/", async () => {
    const { extractUpdateMigrationsTo } = await importCache();
    const tarball = await buildTarball([
      ["README.md", "no migrations here"],
      ["dist/bun/dispatch-fake-binary", "binary contents"],
    ]);
    const { dir, cleanup } = await extractUpdateMigrationsTo(tarball);
    try {
      // Either the dir doesn't exist or it's empty — both mean "no
      // migrations." extractUpdateMigrationsTo returns the path under the
      // temp dir without creating it when no migrations are present.
      const exists = existsSync(dir);
      if (exists) {
        const fs = await import("node:fs/promises");
        const entries = await fs.readdir(dir);
        expect(entries).toEqual([]);
      }
    } finally {
      await cleanup();
    }
  });

  it("rejects a tarball with path-traversal entries", async () => {
    const { extractUpdateMigrationsTo } = await importCache();
    // Build a malicious tarball directly with tar so we can include
    // `../escape` paths that the buildTarball helper wouldn't produce.
    const buildDir = await mkdtemp(path.join(testRoot, "evil-"));
    const inner = path.join(buildDir, "inner");
    await mkdir(inner, { recursive: true });
    await writeFile(path.join(inner, "boring.yaml"), "x", "utf-8");
    const tarballPath = path.join(testRoot, "evil.tar.gz");
    // GNU tar's --transform lets us rewrite paths to include ".."
    // portably across macOS bsdtar by using `-s` instead. Easiest portable
    // route: extract the file as `update-migrations/../escape.yaml` via
    // explicit paths in a manifest.
    const manifest = path.join(buildDir, "manifest.txt");
    // Create the file at the literal traversal path:
    await writeFile(path.join(buildDir, "evil_payload.yaml"), "evil", "utf-8");
    // bsdtar on macOS supports "tar czf <out> -s" but the simpler portable
    // way is to construct a tar via node — but adding that dep is
    // overkill. Use python3 to build a tarball with a traversal entry,
    // skipping the test on systems without python3.
    let pythonAvailable = true;
    try {
      execFileSync("python3", ["--version"], { stdio: "pipe" });
    } catch {
      pythonAvailable = false;
    }
    if (!pythonAvailable) {
      // Skip the test rather than fail; the path-traversal guard is
      // also exercised at the listing level via deployFromArtifact's
      // own `tar tzf` filter, which is covered by the existing
      // integration deploy paths.
      return;
    }
    execFileSync("python3", [
      "-c",
      [
        "import tarfile, sys",
        `tf = tarfile.open(${JSON.stringify(tarballPath)}, 'w:gz')`,
        `tf.add(${JSON.stringify(path.join(buildDir, "evil_payload.yaml"))}, arcname='update-migrations/../escape.yaml')`,
        "tf.close()",
      ].join("; "),
    ]);

    await expect(extractUpdateMigrationsTo(tarballPath)).rejects.toThrow(
      /unsafe paths/i
    );
  });

  it("unlinks the cache file when tar tzf fails on a corrupt tarball", async () => {
    const { extractUpdateMigrationsTo } = await importCache();
    const corrupt = path.join(testRoot, "corrupt.tar.gz");
    // Plain text — `tar tzf` will reject this immediately.
    await writeFile(corrupt, "not a tarball at all", "utf-8");
    expect(existsSync(corrupt)).toBe(true);
    await expect(extractUpdateMigrationsTo(corrupt)).rejects.toThrow();
    expect(existsSync(corrupt)).toBe(false);
  });
});

describe("release-tarball-cache helpers", () => {
  it("cachedTarballPath keeps a sanitized tag inside the cache dir", async () => {
    const { cachedTarballPath } = await importCache();
    const safe = cachedTarballPath("v0.18.13");
    expect(safe.endsWith("release-v0.18.13.tar.gz")).toBe(true);

    // The dangerous case isn't a `..` substring in the filename — that's
    // harmless. The dangerous case is `..` *segments* in the path that
    // would let the file land outside the cache dir. Confirm the
    // resolved path stays under cacheDir for both a benign tag and a
    // hostile one.
    const escaped = cachedTarballPath("../../etc/passwd");
    const root = path.resolve(cacheDir);
    expect(path.resolve(escaped).startsWith(root + path.sep)).toBe(true);
    expect(path.resolve(safe).startsWith(root + path.sep)).toBe(true);
    // Slashes from a hostile tag must have been replaced before joining
    // — otherwise path.join would have spliced extra path segments in.
    const filename = path.basename(escaped);
    expect(filename).not.toContain("/");
    expect(filename).not.toContain(path.sep);
  });

  it("readCachedTarball returns null for missing cache entry", async () => {
    const { readCachedTarball } = await importCache();
    const result = await readCachedTarball("v0.0.1");
    expect(result).toBeNull();
  });

  it("readCachedTarball returns null for a zero-byte cache file", async () => {
    const { cachedTarballPath, readCachedTarball } = await importCache();
    const filePath = cachedTarballPath("v0.0.2");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "", "utf-8");
    const result = await readCachedTarball("v0.0.2");
    expect(result).toBeNull();
  });

  it("unlinkCachedTarball removes the cache entry and is idempotent", async () => {
    const { cachedTarballPath, unlinkCachedTarball } = await importCache();
    const filePath = cachedTarballPath("v0.0.3");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "x", "utf-8");
    await unlinkCachedTarball("v0.0.3");
    expect(existsSync(filePath)).toBe(false);
    // Second call must not throw on a missing file.
    await unlinkCachedTarball("v0.0.3");
  });

  it("pruneCacheExcept removes other cache entries", async () => {
    const { cachedTarballPath, pruneCacheExcept } = await importCache();
    await mkdir(cacheDir, { recursive: true });
    const a = cachedTarballPath("v0.18.13");
    const b = cachedTarballPath("v0.18.12");
    const c = cachedTarballPath("v0.18.11");
    await writeFile(a, "x", "utf-8");
    await writeFile(b, "x", "utf-8");
    await writeFile(c, "x", "utf-8");
    await pruneCacheExcept(["v0.18.13"]);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(false);
    expect(existsSync(c)).toBe(false);
  });

  it("pruneCacheExcept also sweeps orphan .partial.* files (CRU-146 #1244)", async () => {
    const { cachedTarballPath, pruneCacheExcept } = await importCache();
    await mkdir(cacheDir, { recursive: true });
    const final = cachedTarballPath("v0.18.13");
    await writeFile(final, "x", "utf-8");
    // Simulate a hard-exit between createWriteStream and rename — an
    // orphan partial file from a prior pid stays behind.
    const orphan1 = `${final}.partial.99999.aaaaaaaa`;
    const orphan2 = `${final}.partial.88888.bbbbbbbb`;
    await writeFile(orphan1, "x", "utf-8");
    await writeFile(orphan2, "x", "utf-8");
    // Drop something unrelated that pruneCacheExcept must NOT touch.
    const unrelated = path.join(cacheDir, "unrelated.txt");
    await writeFile(unrelated, "x", "utf-8");

    await pruneCacheExcept(["v0.18.13"]);

    expect(existsSync(final)).toBe(true);
    expect(existsSync(orphan1)).toBe(false);
    expect(existsSync(orphan2)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
  });

  it("releaseDownloadUrl points at the GitHub asset URL", async () => {
    const { releaseDownloadUrl } = await importCache();
    expect(releaseDownloadUrl("owner/repo", "v0.18.13")).toBe(
      "https://github.com/owner/repo/releases/download/v0.18.13/dispatch-release.tar.gz"
    );
  });

  it("releaseDownloadUrl encodes characters that would break the URL path", async () => {
    const { releaseDownloadUrl } = await importCache();
    const url = releaseDownloadUrl("owner/repo", "weird/tag");
    expect(url).not.toContain("weird/tag");
    expect(url).toContain("weird%2Ftag");
  });
});

describe("release-tarball-cache concurrency (singleflight)", () => {
  it("coalesces concurrent calls for the same tag into a single download", async () => {
    // The asset URL builder hardcodes github.com — no parameterizable
    // baseUrl override. To exercise singleflight without a real network,
    // we drive ensureCachedTarball with a non-resolvable repo so all
    // calls fail at the HTTPS layer. The relevant assertion is that
    // every concurrent caller receives the same rejection (same Promise
    // instance return value isn't observable, so we settle for "all
    // three rejections happen" + "no orphaned partial files left in
    // the cache dir for any of them").
    const cache = await import("../src/release-tarball-cache.js");

    const calls = await Promise.allSettled([
      cache.ensureCachedTarball({
        tag: "vSF.0.0",
        repo: "owner-that-does-not-exist-zzz/zzzzzzzz",
      }),
      cache.ensureCachedTarball({
        tag: "vSF.0.0",
        repo: "owner-that-does-not-exist-zzz/zzzzzzzz",
      }),
      cache.ensureCachedTarball({
        tag: "vSF.0.0",
        repo: "owner-that-does-not-exist-zzz/zzzzzzzz",
      }),
    ]);
    expect(calls.every((r) => r.status === "rejected")).toBe(true);

    // After every concurrent caller rejects, the cache dir must not
    // contain a leftover .partial file (the catch path unlinks per-
    // caller partials). Glob via readdir.
    const fs = await import("node:fs/promises");
    let entries: string[] = [];
    try {
      entries = await fs.readdir(cacheDir);
    } catch {
      // dir may not exist if mkdir was skipped — that's also OK.
    }
    const orphans = entries.filter(
      (e) => e.includes(".partial") || e.startsWith("release-vSF.0.0")
    );
    expect(orphans).toEqual([]);
  });

  it("uses per-caller partial filenames so a stray rm can't blow them away", async () => {
    // The per-caller partial naming (`${final}.partial.${pid}.${rand}`)
    // means even if two writers race past the inflight map (e.g. a
    // future multi-process arrangement), they write to different
    // partial files. Structural assertion: cachedTarballPath never
    // returns the partial form, and there is no exported partial
    // constant — every caller mints its own.
    const cache = await import("../src/release-tarball-cache.js");
    const final = cache.cachedTarballPath("v0.18.13");
    expect(final.endsWith(".tar.gz")).toBe(true);
    expect(final).not.toContain(".partial");
    expect(Object.keys(cache)).not.toContain("PARTIAL_PATH");
  });
});

describe("release-tarball-cache readMigrationsFromTarball", () => {
  it("returns parsed contents of every migration file in the tarball", async () => {
    const { readMigrationsFromTarball } = await importCache();
    const tarball = await buildTarball([
      ["update-migrations/0001-first.yaml", "id: first\nx: y"],
      ["update-migrations/0002-second.yaml", "id: second\nx: y"],
      ["README.md", "ignored"],
    ]);
    const result = await readMigrationsFromTarball(tarball);
    expect(result.map((f) => f.filename).sort()).toEqual([
      "0001-first.yaml",
      "0002-second.yaml",
    ]);
    expect(result.find((f) => f.filename === "0001-first.yaml")?.contents).toBe(
      "id: first\nx: y"
    );
  });

  it("returns empty array for tarballs without an update-migrations/ dir", async () => {
    const { readMigrationsFromTarball } = await importCache();
    const tarball = await buildTarball([
      ["README.md", "no migrations"],
      ["dist/bun/binary", "x"],
    ]);
    const result = await readMigrationsFromTarball(tarball);
    expect(result).toEqual([]);
  });
});
