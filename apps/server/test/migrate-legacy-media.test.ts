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
  mode: "--dry-run" | "--apply"
) {
  return execFileAsync(script, [mode], {
    env: { ...process.env, HOME: home },
  });
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
});
