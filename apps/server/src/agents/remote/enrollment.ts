import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import https from "node:https";
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
 * Unlike `pairingCommand`, this is not single-use: the runner supplies its
 * own one-time code at connect time, so the same invocation can be copied
 * onto any number of clean runners. The target is always this listener's
 * own pinned CA and port — reachable and verifiable even when the ordinary
 * Dispatch API is loopback-only or plain HTTP, since nothing about it
 * depends on the main API's own binding or certificate.
 */
/**
 * A bare shell word, single-quoted. Only ever used for a URL that already
 * passed `new URL(...)`, so the single-quote rejection is a defense-in-depth
 * backstop, not the primary validation.
 */
function shellSingleQuoted(value: string) {
  if (value.includes("'") || /[\x00-\x1f]/.test(value))
    throw new Error("Value is not safe to embed in a shell command.");
  return `'${value}'`;
}

export function connectCliCommand(input: {
  host: string;
  port: number;
  caFingerprint: string;
  /** Embedded as `--approval-url` so the CLI can print it without needing
   *  the service to know the operator's browser origin on its own. */
  approvalUrl?: string;
}) {
  const pin = normalizeFingerprint(input.caFingerprint)
    .replace(/:/g, "")
    .toLowerCase();
  const parts = [
    // Writing to the default /etc/dispatch-runner needs root, same as
    // remote-runner-pair; unlike that command, this one is copied and run
    // directly by an operator, so spell it out rather than assume it.
    "sudo dispatch-runner connect",
    `--service https://${formatHost(input.host)}:${input.port}`,
    `--ca-sha256 ${pin}`,
  ];
  if (input.approvalUrl !== undefined)
    parts.push(
      `--approval-url ${shellSingleQuoted(new URL(input.approvalUrl).toString())}`
    );
  return parts.join(" ");
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
      "The service certificate does not match the pinned runner CA."
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
      "The service certificate does not match the pinned runner CA."
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

/**
 * Write the enrolled key, certificate and CA to disk and, when a runner.json
 * already exists (or was named with `--config`), update its credential
 * paths and endpoint in place. Shared by both enrollment CLIs.
 */
async function persistRunnerCredentials(input: {
  dir: string;
  config?: string;
  endpoint: string;
  key: string;
  cert: string;
  ca: string;
}) {
  await mkdir(input.dir, { recursive: true, mode: 0o755 });
  const files = {
    ca: path.join(input.dir, "ca.pem"),
    cert: path.join(input.dir, "cert.pem"),
    key: path.join(input.dir, "key.pem"),
  };
  // The key stays root-only; the CLI account reads only the CA.
  await writeAtomic(files.key, input.key, 0o600);
  await writeAtomic(files.cert, input.cert, 0o644);
  await writeAtomic(files.ca, input.ca, 0o644);

  const configFile =
    input.config ??
    (existsSync(path.join(input.dir, "runner.json"))
      ? path.join(input.dir, "runner.json")
      : undefined);
  if (configFile) {
    const current = JSON.parse(readFileSync(configFile, "utf8"));
    const mode = statSync(configFile).mode & 0o777;
    await writeAtomic(
      configFile,
      JSON.stringify(
        { ...current, endpoint: input.endpoint, ...files },
        null,
        2
      ) + "\n",
      mode & 0o077 ? 0o600 : mode
    );
  }
  return { files, configFile };
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
  const { configFile } = await persistRunnerCredentials({
    dir: options.dir,
    config: options.config,
    endpoint: options.endpoint,
    key,
    cert: enrolled.cert,
    ca: enrolled.ca,
  });
  process.stdout.write(
    [
      `Enrolled runner "${enrolled.name}" (${enrolled.id}).`,
      `Credentials: ${options.dir}`,
      configFile
        ? `Updated ${configFile}.`
        : `Add to runner.json: ${JSON.stringify({
            endpoint: options.endpoint,
            ca: path.join(options.dir, "ca.pem"),
            cert: path.join(options.dir, "cert.pem"),
            key: path.join(options.dir, "key.pem"),
          })}`,
      "",
    ].join("\n")
  );
}

/*
 * Runner-initiated ("connect") enrollment. The runner dials the Dispatch
 * service itself — no pairing command to copy — and shows its operator a
 * short code plus a service-provided approval URL. The operator approves
 * through the authenticated Dispatch API with that code and a name; the
 * client certificate is issued automatically for the public key this CLI
 * already submitted, so the code alone can never redeem a different key.
 */

type ConnectOptions = {
  service: string;
  pin?: string;
  dir: string;
  config?: string;
  timeoutMs?: number;
  /** Printed back to the operator as-is; this CLI never dials it. */
  approvalUrl?: string;
};

function parseConnectArgs(argv: string[]): ConnectOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined)
      throw new Error(`Unexpected argument: ${flag ?? ""}`);
    values.set(flag.slice(2), value);
  }
  const service = values.get("service");
  if (!service)
    throw new Error(
      "Usage: dispatch-runner connect --service https://HOST:PORT [--ca-sha256 HEX] [--approval-url URL] [--dir /etc/dispatch-runner] [--config FILE]"
    );
  const approvalUrl = values.get("approval-url");
  if (approvalUrl !== undefined) {
    const protocol = new URL(approvalUrl).protocol;
    if (protocol !== "http:" && protocol !== "https:")
      throw new Error("--approval-url must be an http(s) URL.");
  }
  return {
    service,
    pin: values.get("ca-sha256"),
    dir: path.resolve(values.get("dir") ?? "/etc/dispatch-runner"),
    config: values.get("config"),
    approvalUrl,
  };
}

/**
 * Fetch and pin the service's CA, the same way `exchangeCode` does for the
 * operator-initiated flow and over the same wire-protocol port (`connect`
 * targets the runner listener, which answers `ca_request` directly — see
 * `connectCommand` in service.ts). A single connection cannot both ignore
 * the chain *and* let the caller inspect it: Node exposes a verified peer
 * leaf (`getPeerX509Certificate`) but not the full chain, and that API
 * differs again under Bun. Confirming the CA's own fingerprint this way,
 * then trusting only that CA for the real request, needs neither.
 */
async function fetchPinnedCa(
  endpoint: Endpoint,
  pin: string,
  timeoutMs: number
): Promise<{ caPem: string; ca: X509Certificate }> {
  const caPem = (await roundTrip(
    endpoint,
    {},
    timeoutMs,
    () => ({ type: "ca_request", version: 1 }),
    (reply) => {
      if (reply.type !== "ca") throw new Error("Unexpected pairing reply.");
      pinnedAuthority(reply.ca, pin);
      return reply.ca;
    }
  )) as string;
  return { caPem, ca: pinnedAuthority(caPem, pin) };
}

/**
 * One HTTPS request to the service. With `pin`, first confirms the pinned
 * CA over the runner listener's own wire-protocol bootstrap (see
 * `fetchPinnedCa`), then makes the real request trusting only that CA —
 * ordinary, fully-verified TLS from there, not a from-scratch chain check.
 * Without `pin`, the service is expected to hold an ordinarily trusted
 * certificate.
 */
async function requestJson(
  serviceUrl: string,
  method: string,
  requestPath: string,
  body: unknown,
  options: { pin?: string; timeoutMs?: number } = {}
): Promise<unknown> {
  const url = new URL(requestPath, serviceUrl);
  if (url.protocol !== "https:")
    throw new Error("--service must be an https URL.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port || 443);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pinned =
    options.pin !== undefined
      ? await fetchPinnedCa({ host: hostname, port }, options.pin, timeoutMs)
      : undefined;
  const payload =
    body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      request.destroy();
      finish(new Error("The request to the service timed out."));
    }, timeoutMs);
    const request = https.request(
      {
        hostname,
        port,
        path: url.pathname + url.search,
        method,
        servername: isIP(hostname) ? undefined : hostname,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": payload.length,
            }
          : undefined,
        // A fresh connection every call: this CLI makes only a handful of
        // requests total, and Node's default agent can try to reuse a
        // pooled socket while this request's own TLS verification is still
        // deciding whether to send anything on it, surfacing as a spurious
        // "socket hang up" on the next call.
        agent: false,
        ...(pinned
          ? { ca: pinned.caPem, rejectUnauthorized: true }
          : { rejectUnauthorized: true }),
      },
      (response) => {
        let data = "";
        response.on("data", (chunk) => (data += chunk));
        response.on("end", () => {
          let parsed: unknown;
          try {
            parsed = data ? JSON.parse(data) : undefined;
          } catch {
            return finish(
              new Error("The service sent an unreadable response.")
            );
          }
          if ((response.statusCode ?? 0) >= 400) {
            return finish(
              new Error(
                (parsed as { error?: string } | undefined)?.error ??
                  `The service returned ${response.statusCode}.`
              )
            );
          }
          finish(undefined, parsed);
        });
      }
    );
    request.on("error", (error) => finish(error as Error));
    // Bun starts the HTTPS request on end(). TLS verifies the endpoint
    // hostname and certificate chain against the selected CA before sending.
    request.end(payload);
  });
}

type ConnectCreated = {
  id: string;
  code: string;
  expiresAt: string;
  /** Set only when the service has an approval origin configured. */
  approveUrl?: string;
};
type ConnectPoll =
  | { status: "pending" }
  | {
      status: "approved";
      id: string;
      name: string;
      endpoint: string;
      cert: string;
      ca: string;
    }
  | { status: "denied" }
  | { status: "expired" };

/**
 * Independent, local checks on an approved reply before anything from it
 * is trusted enough to write to disk — on top of, not instead of, the TLS
 * verification `requestJson` already did to receive it.
 */
function verifyIssuedConnectCredentials(
  polled: Extract<ConnectPoll, { status: "approved" }>,
  publicKey: string,
  pin: string | undefined
) {
  if (new URL(polled.endpoint).protocol !== "https:")
    throw new Error("The service returned a non-HTTPS runner endpoint.");
  const issuedCa = new X509Certificate(polled.ca);
  const cert = new X509Certificate(polled.cert);
  if (
    !issuedCa.ca ||
    !cert.checkIssued(issuedCa) ||
    !cert.verify(issuedCa.publicKey) ||
    cert.publicKey.export({ type: "spki", format: "pem" }).toString() !==
      publicKey
  )
    throw new Error(
      "The issued certificate does not match the key this runner generated."
    );
  // The connect endpoint and the runner listener share one CA; a pin
  // checked only at the TLS layer still leaves the two free to disagree.
  if (
    pin !== undefined &&
    issuedCa.fingerprint256 !== normalizeFingerprint(pin)
  )
    throw new Error("The issued CA does not match the pinned runner CA.");
}

/** `dispatch-runner connect …`: ask an operator to approve this runner. */
export async function runRunnerConnect(argv: string[]) {
  const options = parseConnectArgs(argv);
  const { key, publicKey } = generateRunnerKey();
  const created = (await requestJson(
    options.service,
    "POST",
    "/api/runners/connect",
    { publicKey },
    { pin: options.pin, timeoutMs: options.timeoutMs }
  )) as ConnectCreated;

  // `--approval-url` (the operator's own browser, baked into the copied
  // command by connect-command) takes priority: the service's own
  // approveUrl only exists when DISPATCH_RUNNER_APPROVAL_ORIGIN is set,
  // which a preview or default install typically has no reason to.
  const approveUrl = options.approvalUrl ?? created.approveUrl;
  process.stdout.write(
    [
      `Code: ${created.code}`,
      // Same reference the pending-requests list shows in Settings, so an
      // operator juggling more than one pending runner can tell them apart.
      `Request: ${created.id.slice(-8)}`,
      approveUrl
        ? `Approve at: ${approveUrl}`
        : "Ask an operator to approve this runner using the code and request reference above.",
      `This code expires at ${created.expiresAt}.`,
      "Waiting for approval…",
      "",
    ].join("\n")
  );

  const deadline = new Date(created.expiresAt).getTime();
  const pollIntervalMs = 2_000;
  for (;;) {
    if (Date.now() > deadline)
      throw new Error("The connect request expired before it was approved.");
    const polled = (await requestJson(
      options.service,
      "GET",
      `/api/runners/connect/${created.id}`,
      undefined,
      { pin: options.pin, timeoutMs: options.timeoutMs }
    )) as ConnectPoll;
    if (polled.status === "denied")
      throw new Error("The connect request was denied.");
    if (polled.status === "expired")
      throw new Error("The connect request expired before it was approved.");
    if (polled.status === "approved") {
      verifyIssuedConnectCredentials(polled, publicKey, options.pin);
      const { configFile } = await persistRunnerCredentials({
        dir: options.dir,
        config: options.config,
        endpoint: polled.endpoint,
        key,
        cert: polled.cert,
        ca: polled.ca,
      });
      process.stdout.write(
        [
          `Enrolled runner "${polled.name}" (${polled.id}).`,
          `Credentials: ${options.dir}`,
          configFile
            ? `Updated ${configFile}.`
            : `Add to runner.json: ${JSON.stringify({
                endpoint: polled.endpoint,
                ca: path.join(options.dir, "ca.pem"),
                cert: path.join(options.dir, "cert.pem"),
                key: path.join(options.dir, "key.pem"),
              })}`,
          "",
        ].join("\n")
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
