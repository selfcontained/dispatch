#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

const targets = [
  "bun-darwin-x64",
  "bun-darwin-arm64",
  "bun-linux-x64",
  "bun-linux-arm64",
];

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

const checksumLines = [];
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

  const binary = readFileSync(outfile);
  const sha256 = createHash("sha256").update(binary).digest("hex");
  const sizeBytes = statSync(outfile).size;
  checksumLines.push(`${sha256}  ${path.basename(outfile)}  ${sizeBytes}`);
}

writeFileSync(
  path.join(outDir, "SHA256SUMS.txt"),
  `${checksumLines.join("\n")}\n`,
  "utf8"
);

console.log(`Built Bun binaries in ${path.relative(repoRoot, outDir)}`);
