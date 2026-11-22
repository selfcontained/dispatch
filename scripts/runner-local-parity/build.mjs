// Builds one side as the program users run: the compiled binary.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { childProcessEnv } from "../../apps/server/src/shared/process/child-environment.js";

export const repository = fileURLToPath(new URL("../..", import.meta.url));

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? childProcessEnv(),
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      signal: options.signal,
    });
    const output = [];
    const errors = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    if (options.input !== undefined) child.stdin.end(options.input);
    child.once("error", reject);
    child.once("close", (code) => {
      const stdout = Buffer.concat(output).toString("utf8");
      const stderr = Buffer.concat(errors).toString("utf8");
      if (code !== 0 && !options.allowFailure)
        reject(
          new Error(
            `${command} ${args.join(" ")} failed (${code})\n${(stderr || stdout).slice(-4000)}`
          )
        );
      else resolve({ code, stdout, stderr });
    });
  });
}

export async function resolveCommit(ref) {
  const { stdout } = await run(
    "git",
    ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    { cwd: repository }
  );
  return stdout.trim();
}

async function exportCommit(commit, directory, signal) {
  const archive = `${directory}.${randomUUID()}.tar`;
  await run("git", ["archive", "--output", archive, commit], {
    cwd: repository,
    signal,
  });
  await run("tar", ["-xf", archive, "-C", directory], { signal });
  rmSync(archive);
}

/** The head includes uncommitted work, so a task can run this before committing. */
async function exportWorkingTree(directory) {
  const { stdout } = await run(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: repository }
  );
  for (const file of new Set(stdout.split("\0").filter(Boolean))) {
    const from = join(repository, file);
    const info = lstatSync(from, { throwIfNoEntry: false });
    if (!info || info.isDirectory()) continue;
    const to = join(directory, file);
    mkdirSync(dirname(to), { recursive: true });
    if (info.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else copyFileSync(from, to);
  }
}

/** Without `ref`, builds the working tree. Returns the binary and its revision. */
export async function buildSide({ name, ref, root, signal }) {
  const commit = await resolveCommit(ref ?? "HEAD");
  const directory = join(root, `build-${name}`);
  const binary = join(root, `dispatch-${name}`);
  mkdirSync(directory);
  try {
    if (ref) await exportCommit(commit, directory, signal);
    else await exportWorkingTree(directory);

    // The binary embeds its revision. Point a throwaway repository at this
    // commit, reading objects from the real one and writing nothing to it.
    await run("git", ["init", "--quiet"], { cwd: directory });
    const common = await run(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: repository }
    );
    writeFileSync(
      join(directory, ".git/objects/info/alternates"),
      `${join(common.stdout.trim(), "objects")}\n`
    );
    await run("git", ["update-ref", "--no-deref", "HEAD", commit], {
      cwd: directory,
    });

    // The oracle never loads the web app, and building it would double the time.
    mkdirSync(join(directory, "apps/web/dist"), { recursive: true });
    writeFileSync(
      join(directory, "apps/web/dist/index.html"),
      "<!doctype html><title>parity</title>\n"
    );
    await run(
      "pnpm",
      [
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--prefer-offline",
        "--filter",
        "@dispatch/server...",
      ],
      { cwd: directory, signal }
    );
    await run("bun", ["scripts/generate-server-runtime-assets.mjs"], {
      cwd: directory,
      signal,
    });
    await run(
      "bun",
      [
        "build",
        "--compile",
        "--no-compile-autoload-dotenv",
        "apps/server/src/main.ts",
        "--outfile",
        binary,
      ],
      { cwd: directory, signal }
    );
    if (!existsSync(binary)) throw new Error(`No ${name} binary was produced`);
    return { binary, commit };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
