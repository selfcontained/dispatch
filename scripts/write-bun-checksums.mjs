#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const outDir = path.resolve(
  process.argv[2] ?? path.join(repoRoot, "dist", "bun")
);

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
