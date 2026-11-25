#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { childProcessEnv } from "../apps/server/src/shared/process/child-environment.js";
import { checkOwnerCoverage } from "../apps/server/src/personas/coverage.js";

try {
  const result = checkOwnerCoverage({
    cwd: process.cwd(),
    git: (args) =>
      execFileSync("git", args, {
        env: childProcessEnv(),
        cwd: process.cwd(),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    baseSha: process.env.PR_BASE_SHA ?? "",
    headSha: process.env.PR_HEAD_SHA ?? "",
  });
  console.log(
    `Explicit owner coverage: ${result.changedFiles.length} PR head paths, ${result.owners.length} reviewers.`
  );
} catch (error) {
  // Plain text avoids interpreting unusual filenames as workflow annotations.
  console.error(
    error instanceof Error ? error.message : "Owner coverage failed."
  );
  process.exitCode = 1;
}
