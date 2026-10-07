export type DatabaseProbe = {
  name: string;
  oid: string;
  systemIdentifier: string | null;
  migrations: { count: number; latest: string | null };
};

type Queryable = {
  query: (
    text: string,
    values?: unknown[]
  ) => Promise<{ rows: Record<string, unknown>[] }>;
  release: () => void;
};

/**
 * Prove the target can read and write its own database without leaving a
 * trace: identity, migration history, a TEMP-table round trip, and a real
 * transaction id, all rolled back under short timeouts.
 */
export async function probeDatabase(pool: {
  connect: () => Promise<Queryable>;
}): Promise<DatabaseProbe> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");
    const readOnly = await client.query("SHOW transaction_read_only");
    if (readOnly.rows[0]?.transaction_read_only !== "off")
      throw new Error("database is read-only");
    const identity = await client.query(
      `SELECT current_database() AS name,
              (SELECT oid::text FROM pg_database
                WHERE datname = current_database()) AS database_oid,
              txid_current()::text AS xid`
    );
    // The cluster identifier needs pg_control_system(), which a role without
    // monitoring privileges cannot call; the oid then identifies the database.
    let systemIdentifier: string | null = null;
    await client.query("SAVEPOINT dispatch_recovery_identity");
    try {
      const control = await client.query(
        "SELECT system_identifier::text AS id FROM pg_control_system()"
      );
      systemIdentifier = (control.rows[0]?.id as string | undefined) ?? null;
      await client.query("RELEASE SAVEPOINT dispatch_recovery_identity");
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT dispatch_recovery_identity");
    }
    const migrations = await client.query(
      `SELECT count(*)::int AS count,
              (SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1) AS latest
         FROM pgmigrations`
    );
    const token = await client.query(
      "SELECT 1 FROM settings WHERE key = 'auth_token'"
    );
    if (token.rows.length !== 1) throw new Error("auth token is missing");
    await client.query(
      "CREATE TEMP TABLE dispatch_recovery_probe (v text) ON COMMIT DROP"
    );
    await client.query("INSERT INTO dispatch_recovery_probe (v) VALUES ($1)", [
      "probe",
    ]);
    const echo = await client.query("SELECT v FROM dispatch_recovery_probe");
    if (echo.rows[0]?.v !== "probe") throw new Error("probe write mismatch");
    return {
      name: String(identity.rows[0]?.name),
      oid: String(identity.rows[0]?.database_oid),
      systemIdentifier,
      migrations: {
        count: Number(migrations.rows[0]?.count ?? 0),
        latest: (migrations.rows[0]?.latest as string | null) ?? null,
      },
    };
  } finally {
    await client.query("ROLLBACK").catch(() => null);
    client.release();
  }
}
