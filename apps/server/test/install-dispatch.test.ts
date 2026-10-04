import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

describe("install-dispatch systemd unit", () => {
  it("keeps agent hosts alive when Dispatch restarts", async () => {
    const script = await readFile(
      path.join(REPO_ROOT, "bin", "install-dispatch.sh"),
      "utf8"
    );
    expect(script).toContain("KillMode=process");
  });

  it("does not add a shell-environment marker to either service", async () => {
    const script = await readFile(
      path.join(REPO_ROOT, "bin", "install-dispatch.sh"),
      "utf8"
    );
    expect(script).not.toContain("DISPATCH_SHELL_ENV");
  });

  it("records the chosen update channel and never auto-selects a 0.x release", async () => {
    const script = await readFile(
      path.join(REPO_ROOT, "bin", "install-dispatch.sh"),
      "utf8"
    );
    expect(script).toContain('"DISPATCH_UPDATE_CHANNEL=$CHANNEL"');
    expect(script).toContain("releases/download/v[1-9][0-9]*");
    expect(script).not.toContain("applied-migrations");
  });

  it("stays apart from a Dispatch 0.x install", async () => {
    const script = await readFile(
      path.join(REPO_ROOT, "bin", "install-dispatch.sh"),
      "utf8"
    );
    expect(script).toContain('SERVICE="dispatch-server"');
    expect(script).toContain('"DISPATCH_STATE_DIR=$STATE_DIR"');
    expect(script).toContain("/dispatch-server\\.tar\\.gz");
    expect(script).not.toMatch(/STATE_DIR="\$HOME_DIR\/\.dispatch"/);
  });
});

interface InstallerRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the installer up to its download, which fails on a missing local
 * artifact. `psql` and `sudo` are stubs; detached, so it has no terminal to
 * prompt on.
 */
async function runInstallerPreflight(
  args: string[],
  stubs: { psql: string; sudo?: string }
): Promise<InstallerRun> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dispatch-installer-"));
  try {
    const bin = path.join(dir, "bin");
    const home = path.join(dir, "home");
    await mkdir(bin);
    await mkdir(home);
    for (const [name, body] of Object.entries({
      psql: stubs.psql,
      sudo: stubs.sudo ?? "exit 1",
    })) {
      await writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`);
      await chmod(path.join(bin, name), 0o755);
    }
    const child = spawn(
      "bash",
      [
        path.join(REPO_ROOT, "bin", "install-dispatch.sh"),
        "--tag",
        "v1.0.0",
        "--release-url",
        `file://${dir}/missing.tar.gz`,
        "--no-service",
        "--port",
        "7999",
        ...args,
      ],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
          HOME: home,
        },
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const status = await new Promise<number | null>((resolve) =>
      child.on("close", resolve)
    );
    return { status, stdout, stderr };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A psql that administers PostgreSQL and reports the given server version. */
const adminPsql = (versionNum: number) =>
  `case "$*" in *server_version_num*) echo ${versionNum} ;; *rolsuper*) echo t ;; *) echo 1 ;; esac`;

describe("install-dispatch database preflight", () => {
  it("rejects PostgreSQL older than 14 before downloading", async () => {
    const run = await runInstallerPreflight([], { psql: adminPsql(130012) });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      "PostgreSQL 13 is not supported; Dispatch needs PostgreSQL 14 or newer"
    );
    expect(run.stdout).not.toContain("downloading");
  });

  it("accepts PostgreSQL 14 and moves on to the download", async () => {
    const run = await runInstallerPreflight([], { psql: adminPsql(140024) });
    expect(run.stdout).toContain("==> downloading v1.0.0");
    expect(run.stderr).not.toContain("not supported");
  });

  it("stops before downloading when it cannot create the database", async () => {
    const run = await runInstallerPreflight([], {
      psql: "echo 'psql: role does not exist' >&2; exit 2",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("creating Dispatch's database needs");
    expect(run.stdout).not.toContain("downloading");
  });

  it("does not mistake a non-superuser login for admin access", async () => {
    const run = await runInstallerPreflight([], {
      psql: `case "$*" in *rolsuper*) echo f ;; *server_version_num*) echo 170000 ;; *) echo 1 ;; esac`,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("creating Dispatch's database needs");
    expect(run.stdout).not.toContain("downloading");
  });

  it("has no option to bring your own database", async () => {
    const run = await runInstallerPreflight(
      ["--database-url", "postgres://u:p@127.0.0.1:5432/d"],
      { psql: adminPsql(170000) }
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("unknown option: --database-url");
  });

  it.each(["192.168.1.20", "::1", "dispatch.local", "0.0.0.0;id"])(
    "refuses --host %s, which update recovery can't reach on 127.0.0.1",
    async (host) => {
      const run = await runInstallerPreflight(["--host", host], {
        psql: adminPsql(170000),
      });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("--host must be 127.0.0.1 or 0.0.0.0");
    }
  );

  it.each(["127.0.0.1", "0.0.0.0"])("accepts --host %s", async (host) => {
    const run = await runInstallerPreflight(["--host", host], {
      psql: adminPsql(170000),
    });
    expect(run.stdout).toContain("==> downloading");
  });

  it("writes the chosen listen address to .env", async () => {
    const script = await readFile(
      path.join(REPO_ROOT, "bin", "install-dispatch.sh"),
      "utf8"
    );
    expect(script).toContain('"DISPATCH_HOST=$HOST"');
  });
});
