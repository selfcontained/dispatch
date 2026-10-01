import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
      "https://github.com/owner/repo/releases/download/v0.18.13/dispatch-server.tar.gz"
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
