import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

/** Explicit enrollment, not inferred from possession of DATABASE_URL. */
export interface PostgresRecoveryPolicy {
  kind: "dedicated-owned";
  database: string;
  owner: string;
  host: string;
  port: number;
}
export interface PostgresTool {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
export interface PostgresTools {
  pgDump?: PostgresTool;
  pgRestore?: PostgresTool;
}
export interface PostgresBackupMetadata {
  version: 1;
  identity: PostgresRecoveryPolicy;
  databaseOid: string;
  serverMajor: number;
  toolMajor: number;
  archiveSha256: string;
  fingerprint: string;
}
interface Options {
  databaseUrl: string;
  policy: PostgresRecoveryPolicy;
  tools?: PostgresTools;
  timeoutMs?: number;
}
export interface PostgresRestoreResult {
  databaseUrl: string;
  databaseOid: string;
}
interface RestoreOptions extends Options {
  archivePath: string;
  metadata: PostgresBackupMetadata;
}
class RecoveryError extends Error {}
const fail = (message: string): never => {
  throw new RecoveryError(`PostgreSQL recovery: ${message}`);
};
const ident = (value: string) => `"${value.replaceAll('"', '""')}"`;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function connection(options: Options): URL {
  const url = new URL(options.databaseUrl);
  const p = options.policy;
  if (
    !p ||
    p.kind !== "dedicated-owned" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== p.host ||
    Number(url.port || 5432) !== p.port ||
    decodeURIComponent(url.pathname.slice(1)) !== p.database ||
    decodeURIComponent(url.username) !== p.owner ||
    !p.database ||
    ["postgres", "template0", "template1"].includes(p.database) ||
    !p.owner ||
    [...url.searchParams.keys()].some((key) => key !== "sslmode") ||
    (url.searchParams.has("sslmode") &&
      !["disable", "require"].includes(url.searchParams.get("sslmode")!))
  ) {
    fail("a matching local dedicated-owned database enrollment is required");
  }
  return url;
}
function budget(options: Options) {
  const timeout = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3_600_000)
    fail("invalid timeout");
  return timeout;
}
async function client<T>(
  url: URL,
  timeout: number,
  work: (db: pg.Client) => Promise<T>
): Promise<T> {
  const db = new pg.Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: timeout,
    statement_timeout: timeout,
    query_timeout: timeout,
  });
  // Do not let asynchronous connection errors leak credentials or crash the helper.
  db.on("error", () => {});
  try {
    await db.connect();
    return await work(db);
  } finally {
    await db.end().catch(() => {});
  }
}

/** No URL/password in argv; stderr is deliberately never included in errors. */
async function run(
  tool: PostgresTool,
  args: string[],
  url: URL,
  timeout: number,
  io: { input?: number; output?: number } = {}
): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: "C",
    LC_ALL: "C",
    PGHOST: url.hostname.replace(/^\[|\]$/g, ""),
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGCONNECT_TIMEOUT: String(Math.max(1, Math.ceil(timeout / 1000))),
    PGPASSFILE: "/dev/null",
    PGSSLMODE: url.searchParams.get("sslmode") ?? "disable",
    ...tool.env,
  };
  return await new Promise((resolve, reject) => {
    const child = spawn(tool.command, [...(tool.args ?? []), ...args], {
      env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: [io.input ?? "ignore", io.output ?? "pipe", "ignore"],
    });
    let output = "";
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeout);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (output.length < 4096) output += chunk.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new RecoveryError("PostgreSQL recovery: tool could not start"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (expired || code !== 0)
        reject(
          new RecoveryError(
            `PostgreSQL recovery: tool ${expired ? "timed out" : "failed"}`
          )
        );
      else resolve(output);
    });
  });
}
async function preflight(options: Options) {
  const url = connection(options);
  const timeout = budget(options);
  const dump = options.tools?.pgDump ?? { command: "pg_dump" };
  const restore = options.tools?.pgRestore ?? { command: "pg_restore" };
  const identity = await client(url, timeout, async (db) => {
    const { rows } =
      await db.query(`SELECT d.oid::text AS oid, current_database() AS name, current_user AS role,
      pg_get_userbyid(d.datdba) AS owner, r.rolcreatedb OR r.rolsuper AS capable,
      current_setting('server_version_num')::integer / 10000 AS major,
      d.datcollate = t.datcollate AND d.datctype = t.datctype AND d.encoding = t.encoding
        AND (to_jsonb(d)->>'datlocprovider') IS NOT DISTINCT FROM (to_jsonb(t)->>'datlocprovider')
        AND (to_jsonb(d)->>'datlocale') IS NOT DISTINCT FROM (to_jsonb(t)->>'datlocale')
        AND (to_jsonb(d)->>'daticulocale') IS NOT DISTINCT FROM (to_jsonb(t)->>'daticulocale') AS default_locale,
      NOT EXISTS (SELECT 1 FROM pg_db_role_setting s WHERE s.setdatabase=d.oid) AS default_settings
      FROM pg_database d JOIN pg_roles r ON r.rolname = current_user
      CROSS JOIN pg_database t WHERE d.datname = current_database() AND t.datname = 'template0'`);
    const row = rows[0];
    if (
      !row ||
      row.name !== options.policy.database ||
      row.owner !== options.policy.owner ||
      row.role !== options.policy.owner ||
      !row.capable
    )
      fail("database ownership or CREATEDB prerequisite failed");
    if (!row.default_locale || !row.default_settings)
      fail("custom database locale or settings are unsupported");
    return { major: Number(row.major), databaseOid: String(row.oid) };
  });
  const { major, databaseOid } = identity;
  for (const [tool, name] of [
    [dump, "pg_dump"],
    [restore, "pg_restore"],
  ] as const) {
    const version = await run(tool, ["--version"], url, timeout);
    if (
      Number(
        version.match(new RegExp(`^${name} \\(PostgreSQL\\) (\\d+)\\.`))?.[1]
      ) !== major
    ) {
      fail(
        "server and backup tools must have matching PostgreSQL major versions"
      );
    }
  }
  return { url, timeout, dump, restore, major, databaseOid };
}

async function assertNoOtherConnections(
  url: URL,
  timeout: number,
  allowedPid?: number
): Promise<void> {
  await client(url, timeout, async (db) => {
    const { rows } = await db.query(
      `SELECT
      EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND ($1::integer IS NULL OR pid<>$1)) AS connected,
      EXISTS (SELECT 1 FROM pg_prepared_xacts WHERE database=current_database()) AS prepared`,
      [allowedPid ?? null]
    );
    if (rows[0]?.connected || rows[0]?.prepared)
      fail("other database connections or prepared transactions remain");
  });
}

/** Locks existing tables without changing source data. The caller must still fence admission:
 * new objects, sequences, large objects and future connections are not protected by these locks.
 */
async function withLockedSnapshot<T>(
  url: URL,
  timeout: number,
  work: (snapshot: string, backendPid: number) => Promise<T>
): Promise<T> {
  return client(url, timeout, async (db) => {
    await db.query("BEGIN");
    try {
      const tables =
        await db.query(`SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND c.relkind IN ('r','p','m','f')
        ORDER BY n.nspname,c.relname`);
      // Foreign data and materialized-view refresh need separate recovery contracts.
      if (tables.rows.some((row) => !["r", "p"].includes(row.kind)))
        fail("foreign tables and materialized views are unsupported");
      if (tables.rows.length)
        await db.query(
          `LOCK TABLE ${tables.rows.map((row) => `${ident(row.schema)}.${ident(row.name)}`).join(", ")} IN SHARE MODE NOWAIT`
        );
      const { rows } = await db.query(
        "SELECT pg_export_snapshot() AS snapshot, pg_backend_pid() AS pid"
      );
      return await work(rows[0].snapshot, rows[0].pid);
    } finally {
      await db.query("ROLLBACK");
    }
  });
}

/** Full migration history and schema; row counts + deterministic representative rows of every user table. */
async function fingerprint(url: URL, timeout: number): Promise<string> {
  return client(url, timeout, async (db) => {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const schema = await db.query(`SELECT table_schema, table_name, column_name,
      data_type, udt_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name, ordinal_position`);
    const constraints =
      await db.query(`SELECT n.nspname, c.relname, con.conname, pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2,3`);
    const indexes =
      await db.query(`SELECT schemaname, tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2,3`);
    const sequences =
      await db.query(`SELECT schemaname, sequencename, start_value::text, min_value::text,
      max_value::text, increment_by::text, cycle, cache_size::text, last_value::text FROM pg_sequences
      WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2`);
    const views =
      await db.query(`SELECT schemaname, viewname, definition FROM pg_views
      WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2`);
    const extensions = await db.query(
      "SELECT extname, extversion FROM pg_extension ORDER BY extname"
    );
    const tables = await db.query(`SELECT schemaname, tablename FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY schemaname,tablename`);
    if (
      !tables.rows.some(
        (r) => r.schemaname === "public" && r.tablename === "pgmigrations"
      )
    )
      fail("migration history is missing");
    const records = [];
    for (const table of tables.rows) {
      const name = `${ident(table.schemaname)}.${ident(table.tablename)}`;
      const count = await db.query(
        `SELECT count(*)::text AS count FROM ${name}`
      );
      const sample = await db.query(
        `SELECT md5(row_to_json(t)::text) AS hash FROM ${name} t ORDER BY hash ${table.tablename === "pgmigrations" ? "" : "LIMIT 100"}`
      );
      if (
        table.schemaname === "public" &&
        table.tablename === "pgmigrations" &&
        count.rows[0].count === "0"
      )
        fail("migration history is empty");
      records.push({
        ...table,
        count: count.rows[0].count,
        hashes: sample.rows,
      });
    }
    await db.query("COMMIT");
    return digest(
      JSON.stringify({
        schema: schema.rows,
        constraints: constraints.rows,
        indexes: indexes.rows,
        sequences: sequences.rows,
        views: views.rows,
        extensions: extensions.rows,
        records,
      })
    );
  });
}
async function privateParent(file: string) {
  const parent = path.dirname(path.resolve(file));
  if ((await realpath(parent)) !== parent)
    fail("backup directory must not contain symlinks");
  const info = await lstat(parent);
  if (
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    fail("backup directory must be private and owned");
}
/** Never block opening a replaced FIFO; validate both pathname and opened inode. */
async function openPrivateArchive(filePath: string) {
  const before = await lstat(filePath);
  const privateRegular = (entry: typeof before) =>
    entry.isFile() &&
    (entry.mode & 0o077) === 0 &&
    (!process.getuid || entry.uid === process.getuid());
  if (!privateRegular(before)) fail("archive integrity or permissions failed");
  const file = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const opened = await file.stat();
    if (
      !privateRegular(opened) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      fail("archive integrity or permissions failed");
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function archiveHash(file: Awaited<ReturnType<typeof open>>) {
  const hash = createHash("sha256");
  for await (const chunk of file.createReadStream({
    start: 0,
    autoClose: false,
  }))
    hash.update(chunk);
  return hash.digest("hex");
}
async function safe<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    // Even SQL object names and server diagnostics can contain secrets. Never expose causes.
    const message =
      error instanceof RecoveryError
        ? error.message
        : "PostgreSQL recovery: operation failed";
    throw new Error(message);
  }
}
export async function createPostgresBackup(
  options: Options & { outputPath: string }
): Promise<PostgresBackupMetadata> {
  return safe(async () => {
    const { url, timeout, dump, major, databaseOid } = await preflight(options);
    await assertNoOtherConnections(url, timeout);
    await privateParent(options.outputPath);
    return withLockedSnapshot(url, timeout, async (snapshot, backendPid) => {
      const baseline = await fingerprint(url, timeout);
      const file = await open(
        options.outputPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600
      );
      try {
        await run(
          dump,
          ["--format=custom", "--no-password", "--snapshot", snapshot],
          url,
          timeout,
          {
            output: file.fd,
          }
        );
        await file.sync();
      } finally {
        await file.close();
      }
      const parent = await open(
        path.dirname(path.resolve(options.outputPath)),
        constants.O_RDONLY | constants.O_DIRECTORY
      );
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
      const read = await openPrivateArchive(options.outputPath);
      try {
        await assertNoOtherConnections(url, timeout, backendPid);
        if (baseline !== (await fingerprint(url, timeout)))
          fail("database changed during backup; writers must be fenced");
        return {
          version: 1,
          identity: { ...options.policy },
          databaseOid,
          serverMajor: major,
          toolMajor: major,
          archiveSha256: await archiveHash(read),
          fingerprint: baseline,
        };
      } finally {
        await read.close();
      }
    });
  });
}
async function restoreCopy(
  options: RestoreOptions,
  retain: boolean
): Promise<PostgresRestoreResult> {
  return safe(async () => {
    const { url, timeout, restore, major, databaseOid } =
      await preflight(options);
    const meta = options.metadata;
    if (
      !meta ||
      meta.version !== 1 ||
      meta.databaseOid !== databaseOid ||
      meta.serverMajor !== major ||
      meta.toolMajor !== major ||
      Object.keys(options.policy).some(
        (key) =>
          meta.identity[key as keyof PostgresRecoveryPolicy] !==
          options.policy[key as keyof PostgresRecoveryPolicy]
      )
    )
      fail("backup identity mismatch");
    await privateParent(options.archivePath);
    const file = await openPrivateArchive(options.archivePath);
    let created = false;
    let success = false;
    let restoredOid = "";
    const name = `dispatch_recovery_${randomUUID().replaceAll("-", "")}`;
    const target = new URL(url);
    target.pathname = `/${name}`;
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid()) ||
        (await archiveHash(file)) !== meta.archiveSha256
      )
        fail("archive integrity or permissions failed");
      // Hashing used positional reads; restore starts from position zero on this same descriptor.
      await client(url, timeout, async (db) => {
        await db.query(
          `CREATE DATABASE ${ident(name)} WITH TEMPLATE template0`
        );
        created = true;
        const identity = await db.query(
          "SELECT oid::text AS oid FROM pg_database WHERE datname=$1",
          [name]
        );
        restoredOid = identity.rows[0].oid;
        await db.query(`REVOKE CONNECT ON DATABASE ${ident(name)} FROM PUBLIC`);
      });
      await run(
        restore,
        [
          "--format=custom",
          "--exit-on-error",
          "--single-transaction",
          "--no-password",
          "--dbname",
          name,
        ],
        target,
        timeout,
        { input: file.fd }
      );
      if ((await fingerprint(target, timeout)) !== meta.fingerprint)
        fail("restored schema or records do not match backup");
      success = true;
      return { databaseUrl: target.toString(), databaseOid: restoredOid };
    } finally {
      await file.close();
      // The only DROP target is this invocation's unpredictable name, after successful CREATE.
      if (created && (!retain || !success))
        await client(url, timeout, async (db) => {
          const owned = await db.query(
            "SELECT pg_get_userbyid(datdba) = current_user AS owned FROM pg_database WHERE datname=$1",
            [name]
          );
          if (owned.rows[0]?.owned !== true)
            fail("disposable database ownership changed");
          await db.query(`DROP DATABASE ${ident(name)}`);
        });
    }
  });
}
export async function verifyPostgresBackup(
  options: RestoreOptions
): Promise<void> {
  await restoreCopy(options, false);
}
export async function restorePostgresBackup(
  options: RestoreOptions
): Promise<PostgresRestoreResult> {
  return restoreCopy(options, true);
}

/** Verify a durably recorded restore receipt; never infer ownership from a name alone. */
export async function verifyRestoredPostgresDatabase(
  options: Options & { metadata: PostgresBackupMetadata; databaseOid: string }
): Promise<void> {
  return safe(async () => {
    const target = new URL(options.databaseUrl);
    const name = decodeURIComponent(target.pathname.slice(1));
    if (
      !/^dispatch_recovery_[a-f0-9]{32}$/.test(name) ||
      !/^[0-9]+$/.test(options.databaseOid)
    )
      fail("invalid restored database receipt");
    const meta = options.metadata;
    if (
      !meta ||
      meta.version !== 1 ||
      !meta.identity ||
      Object.keys(options.policy).some(
        (key) =>
          meta.identity[key as keyof PostgresRecoveryPolicy] !==
          options.policy[key as keyof PostgresRecoveryPolicy]
      )
    )
      fail("backup identity mismatch");
    const { url, timeout, databaseOid, major } = await preflight({
      ...options,
      policy: { ...options.policy, database: name },
    });
    if (
      databaseOid !== options.databaseOid ||
      major !== meta.serverMajor ||
      major !== meta.toolMajor
    )
      fail("restored database identity mismatch");
    await assertNoOtherConnections(url, timeout);
    if ((await fingerprint(url, timeout)) !== meta.fingerprint)
      fail("restored schema or records do not match backup");
  });
}
