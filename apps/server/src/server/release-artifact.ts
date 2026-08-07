import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import type { RunCommand } from "./release-helpers.js";

export function expectedArtifactMember(tag: string): string {
  const platform =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "linux"
        ? "linux"
        : null;
  const arch =
    process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!platform || !arch)
    throw new Error(
      `Unsupported Dispatch runtime platform: ${process.platform}/${process.arch}`
    );
  return `dist/bun/dispatch-${tag.replace(/^v/, "")}-bun-${platform}-${arch}`;
}

async function tarMemberText(
  tarballPath: string,
  member: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["xOf", tarballPath, member], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks).toString("utf8"))
        : reject(
            new Error(
              `Unable to extract ${member}: ${Buffer.concat(errors).toString("utf8").trim()}`
            )
          )
    );
  });
}

async function extractTarMember(
  tarballPath: string,
  member: string,
  destination: string
): Promise<void> {
  const child = spawn("tar", ["xOf", tarballPath, member], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const errors: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  await pipeline(child.stdout, createWriteStream(destination, { mode: 0o700 }));
  if ((await exited) !== 0)
    throw new Error(
      `Unable to extract ${member}: ${Buffer.concat(errors).toString("utf8").trim()}`
    );
  await chmod(destination, 0o755);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

/** Validates a release tarball then atomically replaces the fixed runtime path. */
export async function verifyAndStageRuntime(input: {
  tarballPath: string;
  tag: string;
  livePath: string;
  runCommand: RunCommand;
}): Promise<void> {
  const { tarballPath, tag, livePath, runCommand } = input;
  const listing = await runCommand("tar", ["tzf", tarballPath]);
  const entries = listing.stdout.split("\n");
  const unsafeEntries = entries.filter(
    (entry) => entry.startsWith("/") || entry.includes("../")
  );
  if (unsafeEntries.length)
    throw new Error(
      `Release artifact contains unsafe paths: ${unsafeEntries.slice(0, 5).join(", ")}`
    );
  const member = expectedArtifactMember(tag);
  if (entries.filter((entry) => entry.trim() === member).length !== 1)
    throw new Error(`Release artifact must contain exactly one ${member}`);
  const verbose = await runCommand("tar", ["tvzf", tarballPath, member]);
  if (!verbose.stdout.trim().startsWith("-"))
    throw new Error(`Release artifact member ${member} is not a regular file`);
  const checksums = await tarMemberText(tarballPath, "dist/bun/SHA256SUMS.txt");
  const line = checksums
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.split(/\s+/)[1] === member.split("/").pop());
  const expected = line?.split(/\s+/)[0];
  if (!expected || !/^[a-f0-9]{64}$/i.test(expected))
    throw new Error(`Release artifact has no valid checksum for ${member}`);

  const runtimeDir = path.dirname(livePath);
  await mkdir(runtimeDir, { recursive: true });
  await Promise.all(
    (await readdir(runtimeDir))
      .filter((name) => name.startsWith(".dispatch.next."))
      .map((name) => rm(path.join(runtimeDir, name), { force: true }))
  );
  const stagingPath = path.join(
    runtimeDir,
    `.dispatch.next.${process.pid}.${Date.now()}`
  );
  try {
    await extractTarMember(tarballPath, member, stagingPath);
    if ((await sha256File(stagingPath)) !== expected)
      throw new Error(`Checksum mismatch for ${member}`);
    const previousPath = `${livePath}.previous`;
    try {
      await lstat(livePath);
      const previousTemp = `${previousPath}.tmp.${process.pid}.${Date.now()}`;
      await link(livePath, previousTemp);
      await rename(previousTemp, previousPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(stagingPath, livePath);
  } catch (error) {
    await rm(stagingPath, { force: true }).catch(() => {});
    throw error;
  }
}
