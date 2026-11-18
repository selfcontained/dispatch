import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { connect, type TLSSocket } from "node:tls";
import { wireFrames } from "./protocol.js";
import { generateRunnerKey, normalizeFingerprint } from "./x509.js";

/*
 * One-time-code pairing. An unauthenticated TLS client on the runner port
 * may send exactly one `enroll` frame. The runner pins the service CA by
 * its SHA-256 fingerprint (carried in the pairing command) before it reveals
 * the code, generates its private key locally and only sends the public key.
 */

export type EnrollFrame =
  | { type: "enroll"; version: 1; code: string; publicKey: string }
  | { type: "enrolled"; id: string; name: string; cert: string; ca: string }
  | { type: "enroll_error"; error: string }
  | { type: "ca_request"; version: 1 }
  | { type: "ca"; ca: string };

/** Display names only; placements address runners by registration id. */
export function validRunnerName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name === name.trim() &&
    name.length > 0 &&
    name.length <= 64 &&
    !/[\x00-\x1f\x7f-\x9f]/u.test(name)
  );
}

/** Mirrors the runner protocol's opaque workspace identity rule. */
export function validWorkspaceId(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    /[\x00-\x1f\x7f-\x9f]/u.test(value)
  )
    return false;
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

export function formatHost(host: string) {
  return isIP(host) === 6 ? `[${host}]` : host;
}

export function pairingCommand(input: {
  host: string;
  port: number;
  caFingerprint: string;
  code: string;
}) {
  const pin = normalizeFingerprint(input.caFingerprint)
    .replace(/:/g, "")
    .toLowerCase();
  return [
    "dispatch-runner remote-runner-pair",
    `--endpoint https://${formatHost(input.host)}:${input.port}`,
    `--ca-sha256 ${pin}`,
    `--code ${input.code}`,
  ].join(" ");
}

/**
 * Check a CA certificate the service presented against the pinned SHA-256
 * fingerprint of its DER bytes. Only public bytes are involved.
 */
export function pinnedAuthority(pem: unknown, pin: string): X509Certificate {
  const expected = normalizeFingerprint(pin);
  let ca: X509Certificate;
  try {
    ca = new X509Certificate(String(pem));
  } catch {
    throw new Error("The service sent an unreadable runner CA.");
  }
  const now = Date.now();
  if (
    ca.fingerprint256 !== expected ||
    !ca.ca ||
    !ca.checkIssued(ca) ||
    !ca.verify(ca.publicKey) ||
    new Date(ca.validFrom).getTime() > now ||
    now > new Date(ca.validTo).getTime()
  ) {
    throw new Error(
      "The service certificate does not match the pinned Dispatch runner CA."
    );
  }
  return ca;
}

/**
 * Defense in depth after a handshake that trusted only the pinned CA: the
 * leaf (exposed the same way by Node and Bun) is issued and signed by it and
 * names the dialed host.
 */
export function verifyServiceLeaf(
  socket: TLSSocket,
  host: string,
  ca: X509Certificate
) {
  const leaf = socket.getPeerX509Certificate();
  const names =
    leaf && (isIP(host) ? leaf.checkIP(host) : leaf.checkHost(host));
  if (
    !socket.authorized ||
    !leaf ||
    !leaf.checkIssued(ca) ||
    !leaf.verify(ca.publicKey) ||
    !names
  ) {
    throw new Error(
      "The service certificate does not match the pinned Dispatch runner CA."
    );
  }
}

type PairOptions = {
  endpoint: string;
  pin: string;
  code: string;
  dir: string;
  config?: string;
  timeoutMs?: number;
};

function parseArgs(argv: string[]): PairOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined)
      throw new Error(`Unexpected argument: ${flag ?? ""}`);
    values.set(flag.slice(2), value);
  }
  const endpoint = values.get("endpoint");
  const pin = values.get("ca-sha256");
  const code = values.get("code");
  if (!endpoint || !pin || !code)
    throw new Error(
      "Usage: dispatch-runner remote-runner-pair --endpoint https://HOST:PORT --ca-sha256 HEX --code CODE [--dir /etc/dispatch-runner] [--config FILE]"
    );
  const dir = path.resolve(values.get("dir") ?? "/etc/dispatch-runner");
  return {
    endpoint,
    pin,
    code,
    dir,
    config: values.get("config"),
  };
}

async function writeAtomic(file: string, data: string, mode: number) {
  const temporary = `${file}.${process.pid}.tmp`;
  await rm(temporary, { force: true });
  try {
    await writeFile(temporary, data, { mode, flag: "wx" });
    await chmod(temporary, mode);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

type Endpoint = { host: string; port: number };

/** One frame out, one frame back, over a fresh TLS connection. */
function roundTrip(
  endpoint: Endpoint,
  tls: { ca?: string },
  timeoutMs: number,
  request: (socket: TLSSocket) => EnrollFrame,
  accept: (reply: EnrollFrame) => unknown
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = connect({
      host: endpoint.host,
      port: endpoint.port,
      ...(isIP(endpoint.host) ? {} : { servername: endpoint.host }),
      ...(tls.ca
        ? { ca: tls.ca, rejectUnauthorized: true }
        : // Bootstrap only: nothing secret is sent on this connection and
          // the returned CA must match the pinned digest.
          { rejectUnauthorized: false }),
    });
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error("Pairing timed out.")),
      timeoutMs
    );
    socket.on("error", (error: Error) => finish(error));
    socket.on("close", () =>
      finish(new Error("The service closed the pairing connection."))
    );
    socket.once("secureConnect", () => {
      let frame: EnrollFrame;
      try {
        frame = request(socket);
      } catch (error) {
        return finish(error as Error);
      }
      const send = wireFrames(socket, (incoming) => {
        const reply = incoming as unknown as EnrollFrame;
        if (reply.type === "enroll_error")
          return finish(new Error(reply.error));
        try {
          finish(undefined, accept(reply));
        } catch (error) {
          finish(error as Error);
        }
      });
      send(frame as never);
    });
  });
}

/**
 * Dial the service and exchange the code for a certificate.
 *
 * 1. Fetch the service's public CA certificate and check it against the
 *    pinned fingerprint. No secret is sent and the peer's chain is not
 *    needed (Bun does not expose it).
 * 2. Pair over an ordinary TLS connection that trusts only that CA and
 *    verifies the hostname, re-checking the leaf, before revealing the code.
 */
export async function exchangeCode(input: {
  endpoint: string;
  pin: string;
  code: string;
  publicKey: string;
  timeoutMs?: number;
}) {
  const url = new URL(input.endpoint);
  if (url.protocol !== "https:")
    throw new Error("The pairing endpoint must use https.");
  const endpoint = {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port || 443),
  };
  const timeoutMs = input.timeoutMs ?? 15_000;
  normalizeFingerprint(input.pin);
  const caPem = (await roundTrip(
    endpoint,
    {},
    timeoutMs,
    () => ({ type: "ca_request", version: 1 }),
    (reply) => {
      if (reply.type !== "ca") throw new Error("Unexpected pairing reply.");
      pinnedAuthority(reply.ca, input.pin);
      return reply.ca;
    }
  )) as string;
  const ca = pinnedAuthority(caPem, input.pin);
  return (await roundTrip(
    endpoint,
    { ca: caPem },
    timeoutMs,
    (socket) => {
      verifyServiceLeaf(socket, endpoint.host, ca);
      return {
        type: "enroll",
        version: 1,
        code: input.code,
        publicKey: input.publicKey,
      };
    },
    (reply) => {
      if (reply.type !== "enrolled")
        throw new Error("Unexpected pairing reply.");
      const issuedCa = new X509Certificate(reply.ca);
      const cert = new X509Certificate(reply.cert);
      if (
        issuedCa.fingerprint256 !== ca.fingerprint256 ||
        !cert.checkIssued(issuedCa) ||
        !cert.verify(issuedCa.publicKey) ||
        cert.publicKey.export({ type: "spki", format: "pem" }) !==
          input.publicKey
      )
        throw new Error("The issued certificate does not match.");
      return reply;
    }
  )) as Extract<EnrollFrame, { type: "enrolled" }>;
}

/** `dispatch-runner remote-runner-pair …`: enroll this host as a runner. */
export async function runRunnerPairing(argv: string[]) {
  const options = parseArgs(argv);
  const { key, publicKey } = generateRunnerKey();
  const enrolled = await exchangeCode({
    endpoint: options.endpoint,
    pin: options.pin,
    code: options.code,
    publicKey,
  });
  await mkdir(options.dir, { recursive: true, mode: 0o755 });
  const files = {
    ca: path.join(options.dir, "ca.pem"),
    cert: path.join(options.dir, "cert.pem"),
    key: path.join(options.dir, "key.pem"),
  };
  // The key stays root-only; the CLI account reads only the CA.
  await writeAtomic(files.key, key, 0o600);
  await writeAtomic(files.cert, enrolled.cert, 0o644);
  await writeAtomic(files.ca, enrolled.ca, 0o644);

  const configFile =
    options.config ??
    (existsSync(path.join(options.dir, "runner.json"))
      ? path.join(options.dir, "runner.json")
      : undefined);
  if (configFile) {
    const current = JSON.parse(readFileSync(configFile, "utf8"));
    const mode = statSync(configFile).mode & 0o777;
    await writeAtomic(
      configFile,
      JSON.stringify(
        { ...current, endpoint: options.endpoint, ...files },
        null,
        2
      ) + "\n",
      mode & 0o077 ? 0o600 : mode
    );
  }
  process.stdout.write(
    [
      `Enrolled runner "${enrolled.name}" (${enrolled.id}).`,
      `Credentials: ${options.dir}`,
      configFile
        ? `Updated ${configFile}.`
        : `Add to runner.json: ${JSON.stringify({ endpoint: options.endpoint, ...files })}`,
      "",
    ].join("\n")
  );
}
