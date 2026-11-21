import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import { isIP } from "node:net";

/*
 * A minimal DER encoder for the three certificate shapes the runner service
 * issues: its CA, its TLS server leaf and enrolled runner client leaves. It
 * avoids depending on an openssl binary on either host (macOS ships
 * LibreSSL, and minimal runner images often ship none).
 */

function length(n: number) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let value = n; value > 0; value >>= 8) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...parts: Buffer[]) {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const sequence = (...parts: Buffer[]) => tlv(0x30, ...parts);
const set = (...parts: Buffer[]) => tlv(0x31, ...parts);
const octets = (value: Buffer) => tlv(0x04, value);
const TRUE = Buffer.from([0x01, 0x01, 0xff]);

function integer(value: Buffer) {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start++;
  const trimmed = value.subarray(start);
  return tlv(
    0x02,
    trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed
  );
}

function oid(dotted: string) {
  const [first, second, ...rest] = dotted.split(".").map(Number);
  const bytes = [first! * 40 + second!];
  for (const component of rest) {
    const chunk = [component & 0x7f];
    for (let value = component >>> 7; value > 0; value >>>= 7)
      chunk.unshift((value & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** A whole-byte BIT STRING (keys and signatures). */
const bits = (value: Buffer) => tlv(0x03, Buffer.from([0]), value);

/** A named-bit BIT STRING such as KeyUsage; DER drops trailing zero bits. */
function flags(value: number) {
  let unused = 0;
  while (unused < 7 && !(value & (1 << unused))) unused++;
  return tlv(0x03, Buffer.from([unused, value]));
}

function time(date: Date) {
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z";
  return date.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(iso.slice(2)))
    : tlv(0x18, Buffer.from(iso));
}

function name(commonName: string) {
  return sequence(
    set(sequence(oid("2.5.4.3"), tlv(0x0c, Buffer.from(commonName))))
  );
}

function extension(id: string, value: Buffer, critical = false) {
  return sequence(oid(id), ...(critical ? [TRUE] : []), octets(value));
}

function ipBytes(address: string) {
  if (isIP(address) === 4)
    return Buffer.from(address.split(".").map((part) => Number(part)));
  const [head = "", tail = ""] = address.split("::");
  const groups = (part: string) => (part ? part.split(":") : []);
  const left = groups(head);
  const right = address.includes("::") ? groups(tail) : [];
  const words = [
    ...left,
    ...Array(8 - left.length - right.length).fill("0"),
    ...right,
  ];
  const out = Buffer.alloc(16);
  words.forEach((word, index) =>
    out.writeUInt16BE(parseInt(word, 16), index * 2)
  );
  return out;
}

function subjectAltNames(hosts: string[]) {
  return sequence(
    ...hosts.map((host) =>
      isIP(host) ? tlv(0x87, ipBytes(host)) : tlv(0x82, Buffer.from(host))
    )
  );
}

const ECDSA_SHA256 = sequence(oid("1.2.840.10045.4.3.2"));

function keyId(publicKey: KeyObject) {
  return createHash("sha1")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest();
}

export type Issued = { cert: string; key?: string };

type Issue = {
  subject: string;
  publicKey: KeyObject;
  issuer: { name: string; key: KeyObject; publicKey: KeyObject };
  days: number;
  extensions: Buffer[];
};

function issue({ subject, publicKey, issuer, days, extensions }: Issue) {
  const notBefore = new Date(Date.now() - 5 * 60 * 1000);
  const notAfter = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const serial = randomBytes(16);
  serial[0]! &= 0x7f;
  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    ECDSA_SHA256,
    name(issuer.name),
    sequence(time(notBefore), time(notAfter)),
    name(subject),
    publicKey.export({ type: "spki", format: "der" }),
    tlv(
      0xa3,
      sequence(
        ...extensions,
        extension("2.5.29.14", octets(keyId(publicKey))),
        extension("2.5.29.35", sequence(tlv(0x80, keyId(issuer.publicKey))))
      )
    )
  );
  const der = sequence(
    tbs,
    ECDSA_SHA256,
    bits(sign("sha256", tbs, issuer.key))
  );
  const body = der.toString("base64").replace(/.{1,64}/g, "$&\n");
  return `-----BEGIN CERTIFICATE-----\n${body}-----END CERTIFICATE-----\n`;
}

function ecKeyPair() {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1" });
}

function pem(key: KeyObject) {
  return key.export({ type: "pkcs8", format: "pem" }).toString();
}

export function issueAuthority(commonName: string): Required<Issued> {
  const { privateKey, publicKey } = ecKeyPair();
  const cert = issue({
    subject: commonName,
    publicKey,
    issuer: { name: commonName, key: privateKey, publicKey },
    days: 3650,
    extensions: [
      extension("2.5.29.19", sequence(TRUE), true),
      // keyCertSign | cRLSign
      extension("2.5.29.15", flags(0x06), true),
    ],
  });
  return { cert, key: pem(privateKey) };
}

function signer(authority: Required<Issued>) {
  const ca = new X509Certificate(authority.cert);
  return {
    name: ca.subject.replace(/^CN=/, ""),
    key: createPrivateKey(authority.key),
    publicKey: ca.publicKey,
  };
}

export function issueServer(
  authority: Required<Issued>,
  hosts: string[]
): Required<Issued> {
  const { privateKey, publicKey } = ecKeyPair();
  const cert = issue({
    subject: hosts[0] ?? "dispatch-runner-service",
    publicKey,
    issuer: signer(authority),
    days: 397,
    extensions: [
      extension("2.5.29.19", sequence(), true),
      // digitalSignature
      extension("2.5.29.15", flags(0x80), true),
      extension("2.5.29.37", sequence(oid("1.3.6.1.5.5.7.3.1"))),
      extension("2.5.29.17", subjectAltNames(hosts)),
    ],
  });
  return { cert, key: pem(privateKey) };
}

/** Accept only modern keys the runner generated itself. */
export function runnerPublicKey(pemText: string) {
  const key = createPublicKey(pemText);
  const details = key.asymmetricKeyDetails;
  if (
    key.asymmetricKeyType === "ec" &&
    ["prime256v1", "secp384r1"].includes(details?.namedCurve ?? "")
  )
    return key;
  if (key.asymmetricKeyType === "ed25519") return key;
  if (key.asymmetricKeyType === "rsa" && (details?.modulusLength ?? 0) >= 2048)
    return key;
  throw new Error("Unsupported runner key");
}

export function issueClient(
  authority: Required<Issued>,
  registrationId: string,
  publicKey: KeyObject
): string {
  return issue({
    subject: registrationId,
    publicKey,
    issuer: signer(authority),
    days: 365,
    extensions: [
      extension("2.5.29.19", sequence(), true),
      extension("2.5.29.15", flags(0x80), true),
      extension("2.5.29.37", sequence(oid("1.3.6.1.5.5.7.3.2"))),
    ],
  });
}

export function generateRunnerKey() {
  const { privateKey, publicKey } = ecKeyPair();
  return {
    key: pem(privateKey),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/**
 * curl's `--pinnedpubkey sha256//…` form: the base64 SHA-256 of a leaf
 * certificate's DER SubjectPublicKeyInfo.
 */
export function publicKeyPin(certPem: string) {
  const spki = new X509Certificate(certPem).publicKey.export({
    type: "spki",
    format: "der",
  });
  return createHash("sha256").update(spki).digest("base64");
}

/** Normalize `AB:CD:…` and bare hex to the colon form Node reports. */
export function normalizeFingerprint(value: string) {
  const hex = value.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  if (hex.length !== 64) throw new Error("Expected a SHA-256 fingerprint");
  return hex.match(/../g)!.join(":");
}
