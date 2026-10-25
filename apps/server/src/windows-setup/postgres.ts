import { randomBytes } from "node:crypto";
import net from "node:net";
import { Client } from "pg";

export function probeTcp(
  host: string,
  port: number,
  timeoutMs = 1500
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export function adminUrl(input: {
  host: string;
  port: number;
  password: string;
}): string {
  return `postgres://postgres:${encodeURIComponent(input.password)}@${input.host}:${input.port}/postgres`;
}

export async function testConnection(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("SELECT 1");
  } finally {
    await client.end();
  }
}

export async function provisionDatabase(input: {
  adminUrl: string;
  host: string;
  port: number;
  role?: string;
  database?: string;
  password?: string;
}): Promise<{ databaseUrl: string }> {
  const role = input.role ?? "dispatch";
  const database = input.database ?? "dispatch";
  const password = input.password ?? randomBytes(24).toString("base64url");

  const client = new Client({ connectionString: input.adminUrl });
  await client.connect();
  try {
    const roleIdent = client.escapeIdentifier(role);
    const passwordLiteral = client.escapeLiteral(password);
    const roles = await client.query(
      "SELECT 1 FROM pg_roles WHERE rolname = $1",
      [role]
    );
    await client.query(
      roles.rowCount
        ? `ALTER ROLE ${roleIdent} WITH LOGIN PASSWORD ${passwordLiteral}`
        : `CREATE ROLE ${roleIdent} LOGIN PASSWORD ${passwordLiteral}`
    );
    const databases = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [database]
    );
    if (!databases.rowCount)
      await client.query(
        `CREATE DATABASE ${client.escapeIdentifier(database)} OWNER ${roleIdent}`
      );
  } finally {
    await client.end();
  }

  const databaseUrl = `postgres://${role}:${encodeURIComponent(password)}@${input.host}:${input.port}/${database}`;
  await testConnection(databaseUrl);
  return { databaseUrl };
}

export function maskPassword(url: string): string {
  return url.replace(/^(postgres(?:ql)?:\/\/[^:/@]*):[^@]*@/, "$1:•••@");
}
