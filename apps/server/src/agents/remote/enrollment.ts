import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { connect, type PeerCertificate, type TLSSocket } from "node:tls";
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
  | { type: "enroll_error"; error: string };

export const RUNNER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

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
 * Verify a TLS peer against a pinned CA without any prior trust store: the
 * chain must contain the pinned CA, the leaf must be issued and signed by it,
 * be currently valid, and name the dialed host.
 */
export function verifyPinnedPeer(
  socket: TLSSocket,
  host: string,
  pin: string
): X509Certificate {
  const expected = normalizeFingerprint(pin);
  const leafInfo = socket.getPeerCertificate(true);
  if (!leafInfo?.raw) throw new Error("The service sent no certificate.");
  const chain: X509Certificate[] = [];
  const seen = new Set<string>();
  for (
    let entry: PeerCertificate | undefined = leafInfo;
    entry?.raw && !seen.has(entry.fingerprint256);
    entry = (entry as { issuerCertificate?: PeerCertificate }).issuerCertificate
  ) {
    seen.add(entry.fingerprint256);
    chain.push(new X509Certificate(entry.raw));
  }
  const leaf = chain[0]!;
  const ca = chain.find((cert) => cert.fingerprint256 === expected);
  const now = Date.now();
  const current = (cert: X509Certificate) =>
    new Date(cert.validFrom).getTime() <= now &&
    now <= new Date(cert.validTo).getTime();
  const names = isIP(host) ? leaf.checkIP(host) : leaf.checkHost(host);
  if (
    !ca ||
    !ca.ca ||
    ca === leaf ||
    !leaf.checkIssued(ca) ||
    !leaf.verify(ca.publicKey) ||
    !current(ca) ||
    !current(leaf) ||
    !names
  ) {
    throw new Error(
      "The service certificate does not match the pinned Dispatch runner CA."
    );
  }
  return ca;
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

/** Dial the service, verify the pin, and exchange the code for a cert. */
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
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port || 443);
  return new Promise<Extract<EnrollFrame, { type: "enrolled" }>>(
    (resolve, reject) => {
      let settled = false;
      const socket = connect({
        host,
        port,
        ...(isIP(host) ? {} : { servername: host }),
        // Trust comes only from the pinned CA, checked before sending the code.
        rejectUnauthorized: false,
      });
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(value as Extract<EnrollFrame, { type: "enrolled" }>);
      };
      const timer = setTimeout(
        () => finish(new Error("Pairing timed out.")),
        input.timeoutMs ?? 15_000
      );
      socket.on("error", (error: Error) => finish(error));
      socket.on("close", () =>
        finish(new Error("The service closed the pairing connection."))
      );
      socket.once("secureConnect", () => {
        let ca: X509Certificate;
        try {
          ca = verifyPinnedPeer(socket, host, input.pin);
        } catch (error) {
          return finish(error as Error);
        }
        const send = wireFrames(socket, (frame) => {
          const reply = frame as unknown as EnrollFrame;
          if (reply.type === "enroll_error")
            return finish(new Error(reply.error));
          if (reply.type !== "enrolled")
            return finish(new Error("Unexpected pairing reply."));
          try {
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
          } catch (error) {
            return finish(error as Error);
          }
          finish(undefined, reply);
        });
        send({
          type: "enroll",
          version: 1,
          code: input.code,
          publicKey: input.publicKey,
        } as never);
      });
    }
  );
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
