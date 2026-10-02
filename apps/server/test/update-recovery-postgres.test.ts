import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import {
  createPostgresBackup,
  restorePostgresBackup,
  verifyPostgresBackup,
  verifyRestoredPostgresDatabase,
  type PostgresBackupMetadata,
  type PostgresRecoveryPolicy,
  type PostgresTools,
} from "../src/update-recovery/postgres.js";
import {
  getTestDatabaseUrl,
  runTestMigrations,
  setupTestDb,
  teardownTestDb,
} from "./db/setup.js";

/** Prefer the fixture container's tools so PATH cannot select another PostgreSQL major. */
function testTools(): PostgresTools | undefined {
  const run = process.env.DISPATCH_DB_NAME;
  const container =
    process.env.DISPATCH_TEST_POSTGRES_CONTAINER ??
    (run?.startsWith("servertest-") ? `dispatch-postgres-${run}` : undefined);
  if (container) {
    if (
      !/^dispatch-(?:ci-[0-9]+|release-verify-pg-[0-9]+|postgres-servertest-[a-zA-Z0-9-]+)$/.test(
        container
      )
    )
      throw new Error(
        "Recovery test tools require an explicitly identified isolated test container"
      );
    const args = [
      "exec",
      "-i",
      ...[
        "PGHOST",
        "PGPORT",
        "PGUSER",
        "PGPASSWORD",
        "PGDATABASE",
        "PGSSLMODE",
      ].flatMap((k) => ["-e", k]),
      container,
    ];
    return {
      pgDump: {
        command: "docker",
        args: [...args, "pg_dump"],
        env: { PGPORT: "5432", PGHOST: "127.0.0.1" },
      },
      pgRestore: {
        command: "docker",
        args: [...args, "pg_restore"],
        env: { PGPORT: "5432", PGHOST: "127.0.0.1" },
      },
    };
  }
  try {
    execFileSync("pg_dump", ["--version"], { stdio: "ignore" });
    execFileSync("pg_restore", ["--version"], { stdio: "ignore" });
    return;
  } catch {
    throw new Error(
      "Install matching pg_dump/pg_restore for externally supplied TEST_DATABASE_URL"
    );
  }
}

describe("PostgreSQL logical recovery (real isolated PostgreSQL)", () => {
  let pool: pg.Pool;
  let directory: string;
  let databaseUrl: string;
  let policy: PostgresRecoveryPolicy;
  let tools: PostgresTools | undefined;
  let metadata: PostgresBackupMetadata;
  let archivePath: string;
  let largeObjectOid: number;
  const recoveredNames: string[] = [];
  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error("Run via the isolated server-test script");
    pool = await setupTestDb();
    // Backup requires every source client to disconnect. Destroy fixture connections on release.
    pool.options.maxUses = 1;
    await runTestMigrations();
    databaseUrl = getTestDatabaseUrl();
    const url = new URL(databaseUrl);
    policy = {
      kind: "dedicated-owned",
      database: url.pathname.slice(1),
      owner: decodeURIComponent(url.username),
      host: url.hostname,
      port: Number(url.port || 5432),
    };
    tools = testTools();
    directory = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "dispatch-postgres-recovery-"))
    );
    archivePath = path.join(directory, "database.dump");
    await pool.query(
      "INSERT INTO agents (id,name,status,cwd) VALUES ('recovery-agent','Recovery agent','idle','/tmp/recovery')"
    );
    await pool.query(
      "INSERT INTO settings (key,value) VALUES ('recovery-test','private-secret-setting')"
    );
    await pool.query(
      "INSERT INTO sessions (token,expires_at) VALUES ('recovery-session', now() + interval '1 day')"
    );
    largeObjectOid = (
      await pool.query(
        "SELECT lo_from_bytea(0, decode('decafbad','hex')) AS oid"
      )
    ).rows[0].oid;
    await pool.query(
      "CREATE TABLE recovery_sequence (id serial PRIMARY KEY, payload bytea); INSERT INTO recovery_sequence (payload) VALUES (decode('aabbcc','hex'))"
    );
  }, 60_000);
  afterAll(async () => {
    for (const name of recoveredNames) {
      if (!/^dispatch_recovery_[a-f0-9]{32}$/.test(name))
        throw new Error("unexpected owned database name");
      await pool.query(`DROP DATABASE "${name}"`);
    }
    await teardownTestDb();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it("rejects an idle source client without terminating it", async () => {
    const other = await pool.connect();
    try {
      await expect(
        createPostgresBackup({
          databaseUrl,
          policy,
          tools,
          outputPath: path.join(directory, "busy.dump"),
        })
      ).rejects.toThrow("other database connections");
      expect((await other.query("SELECT 1 AS alive")).rows[0].alive).toBe(1);
      await expect(stat(path.join(directory, "busy.dump"))).rejects.toThrow();
    } finally {
      other.release(true);
    }
  });
  it("creates a private custom archive and verifies an actual disposable restore", async () => {
    metadata = await createPostgresBackup({
      databaseUrl,
      policy,
      tools,
      outputPath: archivePath,
    });
    expect((await readFile(archivePath)).subarray(0, 5).toString()).toBe(
      "PGDMP"
    );
    expect((await stat(archivePath)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(metadata)).not.toContain("private-secret-setting");
    const before = await pool.query(
      "SELECT datname, oid FROM pg_database WHERE datname ~ '^dispatch_recovery_[0-9a-f]{32}$' OR datname = current_database() ORDER BY datname"
    );
    await verifyPostgresBackup({
      databaseUrl,
      policy,
      tools,
      archivePath,
      metadata,
    });
    expect(
      (
        await pool.query(
          "SELECT datname, oid FROM pg_database WHERE datname ~ '^dispatch_recovery_[0-9a-f]{32}$' OR datname = current_database() ORDER BY datname"
        )
      ).rows
    ).toEqual(before.rows);
  }, 60_000);
  it("restores the baseline into a new database and retains the failed database and schema", async () => {
    const migrations = (
      await pool.query("SELECT * FROM pgmigrations ORDER BY id")
    ).rows;
    await pool.query(
      "UPDATE settings SET value='failed-new-version' WHERE key='recovery-test'; ALTER TABLE agents ADD COLUMN failed_migration text"
    );
    const result = await restorePostgresBackup({
      databaseUrl,
      policy,
      tools,
      archivePath,
      metadata,
    });
    const restoredName = new URL(result.databaseUrl).pathname.slice(1);
    recoveredNames.push(restoredName);
    expect(restoredName).not.toBe(policy.database);
    const receipt = {
      databaseUrl: result.databaseUrl,
      databaseOid: result.databaseOid,
      policy,
      metadata,
      tools,
    };
    await verifyRestoredPostgresDatabase(receipt);
    await expect(
      verifyRestoredPostgresDatabase({ ...receipt, databaseOid: "0" })
    ).rejects.toThrow("identity mismatch");
    await expect(
      verifyRestoredPostgresDatabase({
        ...receipt,
        metadata: { ...metadata, fingerprint: "wrong" },
      })
    ).rejects.toThrow("do not match");
    const restored = new pg.Pool({ connectionString: result.databaseUrl });
    try {
      expect(
        (
          await restored.query("SELECT encode(lo_get($1), 'hex') AS bytes", [
            largeObjectOid,
          ])
        ).rows[0].bytes
      ).toBe("decafbad");
      expect(
        (
          await restored.query(
            "SELECT value FROM settings WHERE key='recovery-test'"
          )
        ).rows[0].value
      ).toBe("private-secret-setting");
      expect(
        (
          await restored.query(
            "SELECT id FROM agents WHERE id='recovery-agent'"
          )
        ).rowCount
      ).toBe(1);
      expect(
        (
          await restored.query(
            "SELECT token FROM sessions WHERE token='recovery-session'"
          )
        ).rowCount
      ).toBe(1);
      expect(
        (await restored.query("SELECT * FROM pgmigrations ORDER BY id")).rows
      ).toEqual(migrations);
      expect(
        (
          await restored.query(
            "INSERT INTO recovery_sequence(payload) VALUES ('x') RETURNING id"
          )
        ).rows[0].id
      ).toBe(2);
      expect(
        (
          await restored.query(
            "SELECT column_name FROM information_schema.columns WHERE table_name='agents' AND column_name='failed_migration'"
          )
        ).rowCount
      ).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT value FROM settings WHERE key='recovery-test'"
          )
        ).rows[0].value
      ).toBe("failed-new-version");
      expect(
        (await pool.query("SELECT failed_migration FROM agents")).rowCount
      ).toBe(1);
    } finally {
      await restored.end();
    }
  }, 60_000);
  it("fails closed for shared/external/mismatched enrollment and incompatible tools", async () => {
    for (const changed of [
      { ...policy, kind: "shared" },
      { ...policy, database: "postgres" },
      { ...policy, owner: "other" },
    ]) {
      await expect(
        createPostgresBackup({
          databaseUrl,
          policy: changed as PostgresRecoveryPolicy,
          tools,
          outputPath: path.join(directory, "rejected"),
        })
      ).rejects.toThrow("enrollment");
    }
    const remote = new URL(databaseUrl);
    remote.hostname = "db.example.com";
    await expect(
      createPostgresBackup({
        databaseUrl: remote.toString(),
        policy: { ...policy, host: "db.example.com" },
        outputPath: path.join(directory, "remote"),
      })
    ).rejects.toThrow("enrollment");
    const mismatch = {
      command: process.execPath,
      args: ["-e", "console.log('pg_dump (PostgreSQL) 1.0')", "--"],
    };
    await expect(
      createPostgresBackup({
        databaseUrl,
        policy,
        tools: { pgDump: mismatch },
        outputPath: path.join(directory, "bad-major"),
      })
    ).rejects.toThrow("matching PostgreSQL major");
  });
  it("rejects tampered archives and fingerprint mismatch without touching source", async () => {
    const corrupt = path.join(directory, "corrupt.dump");
    await writeFile(corrupt, "invalid", { mode: 0o600 });
    await expect(
      verifyPostgresBackup({
        databaseUrl,
        policy,
        tools,
        archivePath: corrupt,
        metadata,
      })
    ).rejects.toThrow("integrity");
    const before = await pool.query(
      "SELECT datname, oid FROM pg_database WHERE datname ~ '^dispatch_recovery_[0-9a-f]{32}$' OR datname = current_database() ORDER BY datname"
    );
    await expect(
      verifyPostgresBackup({
        databaseUrl,
        policy,
        tools,
        archivePath,
        metadata: { ...metadata, fingerprint: "invalid" },
      })
    ).rejects.toThrow("do not match");
    expect(
      (
        await pool.query(
          "SELECT datname, oid FROM pg_database WHERE datname ~ '^dispatch_recovery_[0-9a-f]{32}$' OR datname = current_database() ORDER BY datname"
        )
      ).rows
    ).toEqual(before.rows);
  }, 60_000);
  it("requires CREATEDB capability and ownership before writing any archive", async () => {
    const role = `recovery_limited_${Date.now()}`;
    const database = `${role}_db`;
    await pool.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'test-only-secret' NOCREATEDB`
    );
    try {
      await pool.query(`CREATE DATABASE "${database}" OWNER "${role}"`);
      const limitedUrl = new URL(databaseUrl);
      limitedUrl.username = role;
      limitedUrl.password = "test-only-secret";
      limitedUrl.pathname = `/${database}`;
      await expect(
        createPostgresBackup({
          databaseUrl: limitedUrl.toString(),
          policy: { ...policy, database, owner: role },
          tools,
          outputPath: path.join(directory, "no-privilege"),
        })
      ).rejects.toThrow("CREATEDB prerequisite");
      await expect(
        stat(path.join(directory, "no-privilege"))
      ).rejects.toThrow();
    } finally {
      await pool.query(`DROP DATABASE IF EXISTS "${database}"`);
      await pool.query(`DROP ROLE "${role}"`);
    }
  });
  it("refuses symlinked archives and output replacement", async () => {
    const alias = path.join(directory, "alias.dump");
    await symlink(archivePath, alias);
    await expect(
      verifyPostgresBackup({
        databaseUrl,
        policy,
        tools,
        archivePath: alias,
        metadata,
      })
    ).rejects.toThrow("archive integrity or permissions failed");
    const original = await readFile(archivePath);
    await expect(
      createPostgresBackup({
        databaseUrl,
        policy,
        tools,
        outputPath: archivePath,
      })
    ).rejects.toThrow("operation failed");
    expect(await readFile(archivePath)).toEqual(original);
  });
  it("rejects named pipes without blocking archive reads or post-dump rereads", async () => {
    const fifo = path.join(directory, "fifo.dump");
    execFileSync("mkfifo", ["-m", "600", fifo]);
    const started = Date.now();
    await expect(
      verifyPostgresBackup({
        databaseUrl,
        policy,
        tools,
        archivePath: fifo,
        metadata,
      })
    ).rejects.toThrow("archive integrity or permissions failed");
    await expect(
      restorePostgresBackup({
        databaseUrl,
        policy,
        tools,
        archivePath: fifo,
        metadata,
      })
    ).rejects.toThrow("archive integrity or permissions failed");
    const substituted = path.join(directory, "substituted.dump");
    const script = path.join(directory, "substitute-dump.cjs");
    await writeFile(
      script,
      `
      if (process.argv.includes('--version')) console.log('pg_dump (PostgreSQL) ${metadata.serverMajor}.0');
      else {
        require('node:fs').unlinkSync(${JSON.stringify(substituted)});
        require('node:child_process').execFileSync('mkfifo', ['-m','600',${JSON.stringify(substituted)}]);
      }
    `
    );
    await expect(
      createPostgresBackup({
        databaseUrl,
        policy,
        outputPath: substituted,
        tools: {
          ...tools,
          pgDump: { command: process.execPath, args: [script] },
        },
        timeoutMs: 2000,
      })
    ).rejects.toThrow("archive integrity or permissions failed");
    expect(Date.now() - started).toBeLessThan(5000);
  }, 7000);
  it("holds SHARE locks against row writes and DDL until the exported-snapshot dump finishes", async () => {
    const script = path.join(directory, "locked-dump.cjs");
    const ready = path.join(directory, "dump-ready");
    const proceed = path.join(directory, "dump-proceed");
    const delegate = tools?.pgDump ?? { command: "pg_dump" };
    await writeFile(
      script,
      `
      const fs = require('node:fs');
      const { execFileSync } = require('node:child_process');
      const delegate = ${JSON.stringify(delegate)};
      (async () => {
        if (!process.argv.includes('--version')) {
          fs.writeFileSync(${JSON.stringify(ready)}, 'ready', {mode:384});
          while (!fs.existsSync(${JSON.stringify(proceed)})) await new Promise(resolve => setTimeout(resolve, 10));
        }
        execFileSync(delegate.command, [...(delegate.args || []), ...process.argv.slice(2)],
          {stdio:'inherit', env:{...process.env, ...delegate.env}});
      })().catch(() => process.exit(1));
    `
    );
    const outputPath = path.join(directory, "locked.dump");
    const pending = createPostgresBackup({
      databaseUrl,
      policy,
      outputPath,
      tools: {
        ...tools,
        pgDump: { command: process.execPath, args: [script] },
      },
    });
    // Install a rejection handler immediately while waiting for the barrier.
    void pending.catch(() => {});
    try {
      await expect
        .poll(() => readFile(ready, "utf8").catch(() => ""), {
          timeout: 10_000,
        })
        .toBe("ready");
      const writer = new pg.Client({ connectionString: databaseUrl });
      await writer.connect();
      try {
        await writer.query("SET lock_timeout='100ms'");
        await expect(
          writer.query(
            "UPDATE settings SET value='unexpected' WHERE key='recovery-test'"
          )
        ).rejects.toMatchObject({ code: "55P03" });
        await expect(
          writer.query("ALTER TABLE agents ADD COLUMN unexpected_column text")
        ).rejects.toMatchObject({ code: "55P03" });
      } finally {
        await writer.end();
      }
    } finally {
      await writeFile(proceed, "go");
    }
    const saved = await pending;
    await verifyPostgresBackup({
      databaseUrl,
      policy,
      tools,
      archivePath: outputPath,
      metadata: saved,
    });
  }, 60_000);
  it("redacts tool stderr and kills a hanging tool at the timeout", async () => {
    const script = path.join(directory, "tool.cjs");
    await writeFile(
      script,
      "require('node:fs').writeFileSync(__filename + '.json', JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }), {mode:384}); console.error(process.env.PGPASSWORD); setInterval(() => {}, 1000)"
    );
    const started = Date.now();
    await expect(
      createPostgresBackup({
        databaseUrl,
        policy,
        outputPath: path.join(directory, "timeout"),
        tools: { pgDump: { command: process.execPath, args: [script] } },
        timeoutMs: 500,
      })
    ).rejects.toThrow("tool timed out");
    expect(Date.now() - started).toBeLessThan(5000);
    const child = JSON.parse(await readFile(script + ".json", "utf8"));
    expect(child.argv).toEqual(["--version"]);
    expect(() => process.kill(child.pid, 0)).toThrow();
    await expect(
      createPostgresBackup({
        databaseUrl: "postgres://user:secret%20credential@127.0.0.1:1/db",
        policy: {
          kind: "dedicated-owned",
          database: "db",
          owner: "user",
          host: "127.0.0.1",
          port: 1,
        },
        outputPath: path.join(directory, "no-connect"),
        timeoutMs: 500,
      })
    ).rejects.toThrow(/^PostgreSQL recovery: operation failed$/);
  });
});
