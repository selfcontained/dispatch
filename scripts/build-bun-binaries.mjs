#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const outDir = path.join(repoRoot, "dist", "bun");
const entrypoint = path.join(repoRoot, "apps", "server", "src", "main.ts");
const version = JSON.parse(
  readFileSync(path.join(repoRoot, "package.json"), "utf8")
).version;

const defaultTargets = [
  "bun-darwin-x64",
  "bun-darwin-arm64",
  "bun-linux-x64",
  "bun-linux-arm64",
];
const bundleIdentifier =
  process.env.DISPATCH_MACOS_BUNDLE_ID ?? "dev.bradharris.dispatch";
const entitlementsPath = path.join(
  repoRoot,
  "scripts",
  "dispatch-bun.entitlements.plist"
);
const shouldNotarizeMacos =
  process.env.DISPATCH_NOTARIZE_MACOS_BINARIES === "1";

if (shouldNotarizeMacos && !process.env.DISPATCH_CODESIGN_IDENTITY) {
  console.error(
    "DISPATCH_NOTARIZE_MACOS_BINARIES=1 requires DISPATCH_CODESIGN_IDENTITY"
  );
  process.exit(1);
}

function parseTargets(rawTargets) {
  if (!rawTargets?.trim()) return defaultTargets;
  const targets = rawTargets
    .split(/[,\s]+/)
    .map((target) => target.trim())
    .filter(Boolean);
  const invalidTargets = targets.filter(
    (target) => !defaultTargets.includes(target)
  );
  if (invalidTargets.length > 0) {
    console.error(
      `Unsupported Bun build targets: ${invalidTargets.join(", ")}`
    );
    process.exit(1);
  }
  return targets;
}

function validateNotaryEnv() {
  const requiredVars = ["APPLE_ID", "APPLE_NOTARY_PASSWORD", "APPLE_TEAM_ID"];
  const missingVars = requiredVars.filter((name) => !process.env[name]);
  if (missingVars.length > 0) {
    console.error(`Missing notarization env vars: ${missingVars.join(", ")}`);
    process.exit(1);
  }
}

function signAndMaybeNotarizeMacosBinary(outfile) {
  const signingIdentity = process.env.DISPATCH_CODESIGN_IDENTITY;
  if (!signingIdentity) return;

  if (!existsSync(entitlementsPath)) {
    console.error(`Missing macOS entitlements file: ${entitlementsPath}`);
    process.exit(1);
  }

  run("codesign", [
    "--force",
    "--sign",
    signingIdentity,
    "--options",
    "runtime",
    "--timestamp",
    "--identifier",
    bundleIdentifier,
    "--entitlements",
    entitlementsPath,
    outfile,
  ]);

  if (!shouldNotarizeMacos) return;

  validateNotaryEnv();
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "dispatch-notary-"));
  const zipPath = path.join(tempDir, `${path.basename(outfile)}.zip`);
  try {
    run("ditto", ["-c", "-k", "--keepParent", outfile, zipPath]);
    run("xcrun", [
      "notarytool",
      "submit",
      zipPath,
      "--apple-id",
      process.env.APPLE_ID,
      "--team-id",
      process.env.APPLE_TEAM_ID,
      "--password",
      process.env.APPLE_NOTARY_PASSWORD,
      "--wait",
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeChecksums() {
  const checksumLines = readdirSync(outDir)
    .filter((entry) => entry.startsWith("dispatch-"))
    .sort()
    .map((entry) => {
      const filePath = path.join(outDir, entry);
      const binary = readFileSync(filePath);
      const sha256 = createHash("sha256").update(binary).digest("hex");
      const sizeBytes = statSync(filePath).size;
      return `${sha256}  ${entry}  ${sizeBytes}`;
    });

  writeFileSync(
    path.join(outDir, "SHA256SUMS.txt"),
    `${checksumLines.join("\n")}\n`,
    "utf8"
  );
}

const targets = parseTargets(process.env.DISPATCH_BUN_TARGETS);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

run("pnpm", ["run", "build:web"]);
run("bun", ["scripts/generate-server-runtime-assets.mjs"]);

for (const target of targets) {
  const outfile = path.join(outDir, `dispatch-${version}-${target}`);
  run("bun", [
    "build",
    "--compile",
    `--target=${target}`,
    entrypoint,
    "--outfile",
    outfile,
  ]);
  if (target.startsWith("bun-darwin-")) {
    signAndMaybeNotarizeMacosBinary(outfile);
  }
}

writeChecksums();

console.log(`Built Bun binaries in ${path.relative(repoRoot, outDir)}`);
