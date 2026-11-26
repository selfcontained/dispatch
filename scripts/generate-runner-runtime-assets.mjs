import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const rootPackageJson = path.join(repoRoot, "package.json");
const streamHelper = readFileSync(
  path.join(repoRoot, "bin", "dispatch-stream"),
  "utf8"
);
const packageVersion = (() => {
  const parsed = JSON.parse(readFileSync(rootPackageJson, "utf8"));
  if (typeof parsed.version !== "string" || !parsed.version.trim()) {
    throw new Error(`Missing "version" in ${rootPackageJson}`);
  }
  const value = parsed.version.trim();
  // The version is stamped onto every /api/* response via the
  // X-Dispatch-Version header. Embedded CR/LF/NUL would make Node's
  // http.ServerResponse.setHeader throw ERR_INVALID_CHAR for every
  // request, so fail loudly at build time instead.
  if (!/^[0-9A-Za-z.+-]+$/.test(value)) {
    throw new Error(
      `Invalid "version" in ${rootPackageJson}: ${JSON.stringify(value)}`
    );
  }
  return value;
})();

// Runtime binaries do not have access to the checkout that produced them.
// Keep the build identity beside packageVersion rather than asking git at
// request time. Source-less/reproducible builds are valid and simply have no
// revision identifier.
function embeddedRevision(args, pattern) {
  try {
    const value = execFileSync("git", ["rev-parse", ...args, "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return pattern.test(value) ? value : null;
  } catch {
    return null;
  }
}

const gitSha = embeddedRevision(["--short=12"], /^[0-9a-f]{7,40}$/i);
const buildRevision = embeddedRevision([], /^[0-9a-f]{40}$/);
export const runnerAssets = { packageVersion, gitSha, buildRevision, streamHelper };
const dir = path.join(repoRoot, "packages/runner/src/generated");
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, "runtime-assets.js"), Object.entries(runnerAssets).map(([key,value]) => `export const ${key} = ${JSON.stringify(value)};\n`).join(""));
