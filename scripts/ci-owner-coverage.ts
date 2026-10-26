#!/usr/bin/env bun
import { checkOwnerCoverage } from "../apps/server/src/personas/coverage.js";

try {
  const result = checkOwnerCoverage({
    cwd: process.cwd(),
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
