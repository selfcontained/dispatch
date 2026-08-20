import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptSource = path.resolve(
  import.meta.dirname,
  "../../..",
  "bin/migrate-legacy-media"
);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dispatch-media-root-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "dispatch-media-home-"));
  tempDirs.push(root, home);
  const script = path.join(root, "bin", "migrate-legacy-media");
  await mkdir(path.dirname(script), { recursive: true });
  await copyFile(scriptSource, script);
  await chmod(script, 0o755);
  return {
    root,
    home,
    script,
    sourceDir: path.join(root, "~", ".dispatch", "media"),
    destinationDir: path.join(home, ".dispatch", "media"),
  };
}

async function runMigration(
  script: string,
  home: string,
  mode: "--dry-run" | "--apply",
  options: { args?: string[]; env?: NodeJS.ProcessEnv } = {}
) {
  return execFileAsync(script, [mode, ...(options.args ?? [])], {
    env: {
      ...process.env,
      // The script falls back to MEDIA_ROOT from the environment; an inherited
      // value from the outer test runner would silently retarget the run.
      MEDIA_ROOT: undefined,
      ...options.env,
      HOME: home,
    },
  });
}

/** Write MEDIA_ROOT into the install .env the way the service reads it. */
async function writeEnvFile(root: string, contents: string) {
  await writeFile(path.join(root, ".env"), contents);
}

describe("migrate-legacy-media", () => {
  it("moves literal-tilde media only after an explicit apply", async () => {
    const fixture = await createFixture();
    const source = path.join(fixture.sourceDir, "agt_1", "report.pdf");
    const destination = path.join(
      fixture.destinationDir,
      "agt_1",
      "report.pdf"
    );
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "legacy report");

    const dryRun = await runMigration(
      fixture.script,
      fixture.home,
      "--dry-run"
    );
    expect(dryRun.stdout).toContain("would move: agt_1/report.pdf");
    await expect(readFile(source, "utf8")).resolves.toBe("legacy report");

    const applied = await runMigration(fixture.script, fixture.home, "--apply");
    expect(applied.stdout).toContain("moved: agt_1/report.pdf");
    await expect(readFile(destination, "utf8")).resolves.toBe("legacy report");
    await expect(readFile(source, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not overwrite a conflicting destination file", async () => {
    const fixture = await createFixture();
    const source = path.join(fixture.sourceDir, "agt_1", "report.pdf");
    const destination = path.join(
      fixture.destinationDir,
      "agt_1",
      "report.pdf"
    );
    await mkdir(path.dirname(source), { recursive: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(source, "legacy report");
    await writeFile(destination, "new report");

    await expect(
      runMigration(fixture.script, fixture.home, "--apply")
    ).rejects.toMatchObject({ code: 2 });
    await expect(readFile(source, "utf8")).resolves.toBe("legacy report");
    await expect(readFile(destination, "utf8")).resolves.toBe("new report");
  });

  it("does not replace a dangling destination symlink", async () => {
    const fixture = await createFixture();
    const source = path.join(fixture.sourceDir, "agt_1", "report.pdf");
    const destination = path.join(
      fixture.destinationDir,
      "agt_1",
      "report.pdf"
    );
    await mkdir(path.dirname(source), { recursive: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(source, "legacy report");
    await symlink("missing-report.pdf", destination);

    await expect(
      runMigration(fixture.script, fixture.home, "--apply")
    ).rejects.toMatchObject({ code: 2 });
    await expect(readFile(source, "utf8")).resolves.toBe("legacy report");
    expect((await lstat(destination)).isSymbolicLink()).toBe(true);
  });

  it("does not follow a destination ancestor symlink", async () => {
    const fixture = await createFixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "dispatch-outside-"));
    tempDirs.push(outside);
    const source = path.join(fixture.sourceDir, "agt_1", "report.pdf");
    const linkedAgentDir = path.join(fixture.destinationDir, "agt_1");
    await mkdir(path.dirname(source), { recursive: true });
    await mkdir(fixture.destinationDir, { recursive: true });
    await writeFile(source, "legacy report");
    await symlink(outside, linkedAgentDir);

    await expect(
      runMigration(fixture.script, fixture.home, "--apply")
    ).rejects.toMatchObject({ code: 2 });
    await expect(readFile(source, "utf8")).resolves.toBe("legacy report");
    expect((await lstat(linkedAgentDir)).isSymbolicLink()).toBe(true);
    await expect(
      readFile(path.join(outside, "report.pdf"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves a non-default tilde MEDIA_ROOT from the install .env", async () => {
    const fixture = await createFixture();
    await writeEnvFile(fixture.root, "MEDIA_ROOT=~/dispatch-media\n");
    // The legacy tree lives under the configured value, not the default one.
    const source = path.join(
      fixture.root,
      "~",
      "dispatch-media",
      "agt_1",
      "shot.png"
    );
    const destination = path.join(
      fixture.home,
      "dispatch-media",
      "agt_1",
      "shot.png"
    );
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "legacy shot");

    const applied = await runMigration(fixture.script, fixture.home, "--apply");
    expect(applied.stdout).toContain("moved: agt_1/shot.png");
    await expect(readFile(destination, "utf8")).resolves.toBe("legacy shot");
  });

  it("accepts an explicit --media-root over the .env value", async () => {
    const fixture = await createFixture();
    await writeEnvFile(fixture.root, "MEDIA_ROOT=~/dispatch-media\n");
    const source = path.join(
      fixture.root,
      "~",
      "override",
      "agt_1",
      "shot.png"
    );
    const destination = path.join(
      fixture.home,
      "override",
      "agt_1",
      "shot.png"
    );
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "legacy shot");

    const applied = await runMigration(
      fixture.script,
      fixture.home,
      "--apply",
      {
        args: ["--media-root", "~/override"],
      }
    );
    expect(applied.stdout).toContain("moved: agt_1/shot.png");
    await expect(readFile(destination, "utf8")).resolves.toBe("legacy shot");
  });

  it("is a no-op on an install whose MEDIA_ROOT is absolute", async () => {
    const fixture = await createFixture();
    await writeEnvFile(fixture.root, "MEDIA_ROOT=/var/lib/dispatch/media\n");
    // A stray legacy tree must still be left alone: an absolute MEDIA_ROOT was
    // never resolved through the broken tilde path, so nothing here is ours.
    const source = path.join(fixture.sourceDir, "agt_1", "report.pdf");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "legacy report");

    const applied = await runMigration(fixture.script, fixture.home, "--apply");
    expect(applied.stdout).toContain("nothing to migrate");
    await expect(readFile(source, "utf8")).resolves.toBe("legacy report");
  });

  it("fails instead of reporting a clean result when the scan is incomplete", async () => {
    const fixture = await createFixture();
    const readable = path.join(fixture.sourceDir, "agt_1", "report.pdf");
    const lockedDir = path.join(fixture.sourceDir, "agt_locked");
    await mkdir(path.dirname(readable), { recursive: true });
    await mkdir(lockedDir, { recursive: true });
    await writeFile(readable, "legacy report");
    await writeFile(path.join(lockedDir, "hidden.pdf"), "hidden");
    await chmod(lockedDir, 0o000);

    try {
      // find cannot descend into the locked directory. Exiting 0 with a
      // zero-conflict summary here would let the manifest greenlight --apply
      // from a scan that never saw `hidden.pdf`.
      const result = await runMigration(
        fixture.script,
        fixture.home,
        "--dry-run"
      ).then(
        () => null,
        (err: { code?: number; stderr?: string }) => err
      );
      expect(result?.code).toBe(1);
      expect(result?.stderr).toContain("incomplete scan");
    } finally {
      await chmod(lockedDir, 0o755);
    }
  });

  it("treats a destination that appears mid-migration as a conflict", async () => {
    const fixture = await createFixture();
    const source = path.join(fixture.sourceDir, "agt_1", "report.pdf");
    const destination = path.join(
      fixture.destinationDir,
      "agt_1",
      "report.pdf"
    );
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "legacy report");

    // Shim `mkdir` so a file lands at the destination in the exact window
    // between the script's preflight checks and its placement — the race a
    // live Dispatch server can win by writing media while the migration runs.
    const shimDir = await mkdtemp(path.join(os.tmpdir(), "dispatch-shim-"));
    tempDirs.push(shimDir);
    const shim = path.join(shimDir, "mkdir");
    await writeFile(
      shim,
      `#!/bin/bash\n/bin/mkdir "$@"\nprintf 'raced in' > ${JSON.stringify(destination)} 2>/dev/null || true\n`
    );
    await chmod(shim, 0o755);

    await expect(
      runMigration(fixture.script, fixture.home, "--apply", {
        env: { PATH: `${shimDir}:${process.env.PATH ?? ""}` },
      })
    ).rejects.toMatchObject({ code: 2 });
    await expect(readFile(destination, "utf8")).resolves.toBe("raced in");
    await expect(readFile(source, "utf8")).resolves.toBe("legacy report");
  });

  it("prefers a service-level MEDIA_ROOT over the .env value", async () => {
    const fixture = await createFixture();
    // dotenv does not override a variable already in the process environment,
    // so a systemd Environment= line is what the service actually ran with.
    await writeEnvFile(fixture.root, "MEDIA_ROOT=/var/lib/dispatch/media\n");
    const unitDir = path.join(fixture.home, ".config", "systemd", "user");
    await mkdir(unitDir, { recursive: true });
    await writeFile(
      path.join(unitDir, "dispatch.service"),
      "[Service]\nEnvironment=MEDIA_ROOT=~/svc-media\nExecStart=/x\n"
    );
    const source = path.join(fixture.root, "~", "svc-media", "agt_1", "s.png");
    const destination = path.join(fixture.home, "svc-media", "agt_1", "s.png");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "service shot");

    const applied = await runMigration(fixture.script, fixture.home, "--apply");
    expect(applied.stdout).toContain("moved: agt_1/s.png");
    await expect(readFile(destination, "utf8")).resolves.toBe("service shot");
  });

  it("refuses to classify an install as unaffected while a legacy tree exists", async () => {
    const fixture = await createFixture();
    await writeEnvFile(fixture.root, "MEDIA_ROOT=/var/lib/dispatch/media\n");
    // The readable config says absolute, but files under a literal `~` prove
    // the running service used something else. Guessing "no-op" here would
    // silently strand them.
    const source = path.join(fixture.root, "~", "mystery", "agt_1", "o.png");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "orphan");

    const result = await runMigration(
      fixture.script,
      fixture.home,
      "--apply"
    ).then(
      () => null,
      (err: { code?: number; stderr?: string }) => err
    );
    expect(result?.code).toBe(1);
    expect(result?.stderr).toContain("--media-root");
    await expect(readFile(source, "utf8")).resolves.toBe("orphan");
  });

  it("fails closed when a destination ancestor is swapped mid-migration", async () => {
    const fixture = await createFixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "dispatch-outside-"));
    tempDirs.push(outside);
    const source = path.join(fixture.sourceDir, "agt_1", "report.pdf");
    const agentDir = path.join(fixture.destinationDir, "agt_1");
    await mkdir(path.dirname(source), { recursive: true });
    await mkdir(fixture.destinationDir, { recursive: true });
    await writeFile(source, "legacy report");

    // Swap the agent directory for a symlink *after* the ancestor preflight,
    // in the window a path-based check cannot cover. Placement holds a kernel
    // directory reference and verifies where it landed, so this must not write
    // through the symlink.
    const shimDir = await mkdtemp(path.join(os.tmpdir(), "dispatch-shim-"));
    tempDirs.push(shimDir);
    const shim = path.join(shimDir, "mkdir");
    await writeFile(
      shim,
      [
        "#!/bin/bash",
        '/bin/mkdir "$@"',
        `if [[ -d ${JSON.stringify(agentDir)} && ! -L ${JSON.stringify(agentDir)} ]]; then`,
        `  /bin/rmdir ${JSON.stringify(agentDir)} 2>/dev/null && /bin/ln -s ${JSON.stringify(outside)} ${JSON.stringify(agentDir)}`,
        "fi",
        "",
      ].join("\n")
    );
    await chmod(shim, 0o755);

    await expect(
      runMigration(fixture.script, fixture.home, "--apply", {
        env: { PATH: `${shimDir}:${process.env.PATH ?? ""}` },
      })
    ).rejects.toMatchObject({ code: 2 });
    await expect(readFile(source, "utf8")).resolves.toBe("legacy report");
    await expect(
      readFile(path.join(outside, "report.pdf"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
