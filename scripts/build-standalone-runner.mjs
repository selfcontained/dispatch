#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [target, output] = process.argv.slice(2);
if (!/^bun-(linux|darwin)-(x64|arm64)$/.test(target ?? "")) {
  throw new Error("Usage: bun scripts/build-standalone-runner.mjs TARGET [OUTPUT]");
}
const { runnerAssets } = await import("./generate-runner-runtime-assets.mjs");
const defines = {};
if (process.env.DISPATCH_RUNNER_UPDATE_DEV_BUILD === "1") {
  const { loadRunnerDevKey } = await import("./runner-dev-key.mjs");
  defines.DISPATCH_COMPILED_RUNNER_DEV_KEY = loadRunnerDevKey().publicKey;
}
const outfile = path.resolve(output ?? path.join(root, "dist/runner/dist/bun", `dispatch-${runnerAssets.packageVersion}-${target}`));
mkdirSync(path.dirname(outfile), { recursive: true });
const stage = mkdtempSync(path.join(path.dirname(outfile), ".build-"));
try {
  const metafile = path.join(stage, "inputs.json");
  const binary = path.join(stage, path.basename(outfile));
  const result = spawnSync(process.execPath, ["build", "--compile", "--no-compile-autoload-dotenv",
    `--metafile=${metafile}`, `--target=${target}`, ...Object.entries(defines).flatMap(([key, value]) => ["--define", `${key}=${JSON.stringify(value)}`]),
    "packages/runner/src/standalone.ts", "--outfile", binary], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error("Standalone runner compilation failed");
  const inputs = Object.keys(JSON.parse(readFileSync(metafile, "utf8")).inputs);
  if (!inputs.includes("packages/runner/src/standalone.ts")) throw new Error("Missing runner entry in build graph");
  for (const file of inputs) {
    if (!/^(?:packages\/runner(?:-protocol|-client)?\/|node_modules\/)/.test(file) || /(?:^|\/)node_modules\/(?:postgres|pg|drizzle-orm)(?:\/|$)/.test(file)) {
      throw new Error(`Unexpected standalone runner build input: ${file}`);
    }
  }
  renameSync(binary, outfile);
} finally {
  rmSync(stage, { recursive:true,force:true });
}
