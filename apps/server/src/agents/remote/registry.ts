import type { RunnerHealth } from "./protocol.js";
import { createHash, randomBytes } from "node:crypto";
import { X509Certificate } from "node:crypto";
import type { Pool } from "pg";
import {
  issueAuthority,
  issueClient,
  issueServer,
  runnerPublicKey,
  type Issued,
} from "./x509.js";

export type Authority = {
  ca: Required<Issued>;
  server: Required<Issued>;
  hosts: string[];
  port: number | null;
};

export type Registration = {
  id: string;
  name: string;
  endpointHost: string;
  fingerprint: string | null;
  workspaces: string[];
  managedWorkspace: boolean;
  enrolled: boolean;
  revoked: boolean;
  codeExpiresAt: Date | null;
  health?: RunnerHealth;
  healthReceivedAt?: Date;
};

type Row = {
  id: string;
  name: string;
  endpoint_host: string;
  cert_fingerprint: string | null;
  workspaces: string[];
  managed_workspace: boolean;
  enrolled_at: Date | null;
  revoked_at: Date | null;
  code_expires_at: Date | null;
  health: RunnerHealth | null;
  health_received_at: Date | null;
};

const PAIRING_TTL_MS = 10 * 60 * 1000;

export class RunnerNameTaken extends Error {}
export class PairingRejected extends Error {}

function hashCode(code: string) {
  return createHash("sha256").update(code).digest("hex");
}

function registration(row: Row): Registration {
  return {
    id: row.id,
    name: row.name,
    endpointHost: row.endpoint_host,
    fingerprint: row.cert_fingerprint,
    workspaces: row.workspaces,
    managedWorkspace: row.managed_workspace,
    enrolled: Boolean(row.enrolled_at),
    revoked: Boolean(row.revoked_at),
    codeExpiresAt: row.code_expires_at,
    health: row.health ?? undefined,
    healthReceivedAt: row.health_received_at ?? undefined,
  };
}

/** PostgreSQL persistence for the runner CA, registrations and pairing codes. */
export class RunnerRegistry {
  constructor(private readonly pool: Pool) {}

  /** Load the authority, creating the CA on first use and widening SANs. */
  async authority(hosts: string[] = []): Promise<Authority> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT ca_cert, ca_key, server_cert, server_key, server_hosts, port
           FROM runner_authority WHERE id = 1 FOR UPDATE`
      );
      let row = rows[0] as
        | {
            ca_cert: string;
            ca_key: string;
            server_cert: string;
            server_key: string;
            server_hosts: string[];
            port: number | null;
          }
        | undefined;
      const ca = row
        ? { cert: row.ca_cert, key: row.ca_key }
        : issueAuthority(
            `Dispatch runner CA ${randomBytes(4).toString("hex")}`
          );
      const known = row?.server_hosts ?? [];
      const wanted = [...new Set([...known, ...hosts])];
      const renew =
        !row ||
        wanted.length !== known.length ||
        new Date(new X509Certificate(row.server_cert).validTo).getTime() -
          Date.now() <
          30 * 24 * 60 * 60 * 1000;
      if (renew) {
        const server = issueServer(ca, wanted.length ? wanted : ["localhost"]);
        await client.query(
          `INSERT INTO runner_authority
             (id, ca_cert, ca_key, server_cert, server_key, server_hosts)
           VALUES (1, $1, $2, $3, $4, $5::jsonb)
           ON CONFLICT (id) DO UPDATE SET
             server_cert = EXCLUDED.server_cert,
             server_key = EXCLUDED.server_key,
             server_hosts = EXCLUDED.server_hosts,
             updated_at = now()`,
          [ca.cert, ca.key, server.cert, server.key, JSON.stringify(wanted)]
        );
        row = {
          ca_cert: ca.cert,
          ca_key: ca.key,
          server_cert: server.cert,
          server_key: server.key,
          server_hosts: wanted,
          port: row?.port ?? null,
        };
      }
      await client.query("COMMIT");
      const stored = row!;
      return {
        ca,
        server: { cert: stored.server_cert, key: stored.server_key },
        hosts: stored.server_hosts,
        port: stored.port,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async savePort(port: number) {
    await this.pool.query(
      `UPDATE runner_authority SET port = $1, updated_at = now() WHERE id = 1`,
      [port]
    );
  }

  /** Never-redeemed codes stop holding their name once they expire. */
  private async pruneExpired() {
    await this.pool.query(
      `DELETE FROM runner_registrations
        WHERE enrolled_at IS NULL AND code_expires_at <= now()`
    );
  }

  async list(): Promise<Registration[]> {
    await this.pruneExpired();
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM runner_registrations ORDER BY created_at, id`
    );
    return rows.map(registration);
  }

  async active(): Promise<Registration[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM runner_registrations
        WHERE revoked_at IS NULL AND cert_fingerprint IS NOT NULL`
    );
    return rows.map(registration);
  }

  async isRevoked(id: string): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT 1 FROM runner_registrations WHERE id = $1 AND revoked_at IS NOT NULL",
      [id]
    );
    return result.rows.length > 0;
  }

  async hasActive() {
    await this.pruneExpired();
    const { rows } = await this.pool.query(
      `SELECT 1 FROM runner_registrations WHERE revoked_at IS NULL LIMIT 1`
    );
    return rows.length > 0;
  }

  async create(name: string, endpointHost: string) {
    await this.pruneExpired();
    const id = `rnr_${randomBytes(6).toString("hex")}`;
    const code = randomBytes(20).toString("base64url");
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    try {
      await this.pool.query(
        `INSERT INTO runner_registrations
           (id, name, endpoint_host, code_hash, code_expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, name, endpointHost, hashCode(code), expiresAt]
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        throw new RunnerNameTaken(`A runner named "${name}" already exists.`);
      throw error;
    }
    return { id, code, expiresAt };
  }

  /**
   * Redeem a one-time code: issue a client certificate for the runner's own
   * public key and bind the registration to that certificate's fingerprint.
   */
  async redeem(code: string, publicKeyPem: string) {
    const publicKey = (() => {
      try {
        return runnerPublicKey(publicKeyPem);
      } catch {
        throw new PairingRejected("The runner key is not supported.");
      }
    })();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // A code may enroll a pending registration or re-key an enrolled one.
      const { rows } = await client.query<Row>(
        `SELECT * FROM runner_registrations
          WHERE code_hash = $1 AND revoked_at IS NULL
            AND code_expires_at > now()
          FOR UPDATE`,
        [hashCode(code)]
      );
      const row = rows[0];
      if (!row)
        throw new PairingRejected(
          "The pairing code is invalid, expired or already used."
        );
      const { rows: authority } = await client.query(
        `SELECT ca_cert, ca_key FROM runner_authority WHERE id = 1`
      );
      const ca = { cert: authority[0].ca_cert, key: authority[0].ca_key };
      const cert = issueClient(ca, row.id, publicKey);
      const parsed = new X509Certificate(cert);
      await client.query(
        `UPDATE runner_registrations
            SET code_hash = NULL, code_expires_at = NULL,
                enrolled_at = COALESCE(enrolled_at, now()),
                cert_fingerprint = $2, cert_expires_at = $3
          WHERE id = $1`,
        [row.id, parsed.fingerprint256, new Date(parsed.validTo)]
      );
      await client.query("COMMIT");
      return {
        previousFingerprint: row.cert_fingerprint,
        registration: registration({
          ...row,
          cert_fingerprint: parsed.fingerprint256,
          enrolled_at: new Date(),
        }),
        cert,
        ca: ca.cert,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Issue a fresh one-time code for an existing registration. Redeeming it
   * replaces the client certificate (renewal or re-key) and keeps the id, so
   * placements keep addressing the same runner.
   */
  async reissue(id: string, endpointHost: string) {
    const code = randomBytes(20).toString("base64url");
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    const { rowCount } = await this.pool.query(
      `UPDATE runner_registrations
          SET code_hash = $2, code_expires_at = $3, endpoint_host = $4
        WHERE id = $1 AND revoked_at IS NULL`,
      [id, hashCode(code), expiresAt, endpointHost]
    );
    return rowCount ? { id, code, expiresAt } : undefined;
  }

  async connected(id: string, workspaces: string[], managedWorkspace = false) {
    await this.pool.query(
      `UPDATE runner_registrations
          SET workspaces = $2::jsonb, managed_workspace = $3, last_seen_at = now()
        WHERE id = $1 AND revoked_at IS NULL`,
      [id, JSON.stringify(workspaces), managedWorkspace]
    );
  }

  async recordHealth(id: string, sample: RunnerHealth, receivedAt: Date) {
    await this.pool.query(
      `UPDATE runner_registrations SET health = $2::jsonb, health_received_at = $3, last_seen_at = now()
       WHERE id = $1 AND revoked_at IS NULL AND (health_received_at IS NULL OR health_received_at <= $3)`,
      [id, JSON.stringify(sample), receivedAt]
    );
  }

  async seen(id: string) {
    await this.pool.query(
      `UPDATE runner_registrations SET last_seen_at = now() WHERE id = $1`,
      [id]
    );
  }

  /** Revoke a registration; its code and certificate stop working at once. */
  async revoke(id: string): Promise<Registration | undefined> {
    const { rows } = await this.pool.query<Row>(
      `UPDATE runner_registrations
          SET revoked_at = COALESCE(revoked_at, now()), code_hash = NULL
        WHERE id = $1
        RETURNING *`,
      [id]
    );
    return rows[0] ? registration(rows[0]) : undefined;
  }
}
