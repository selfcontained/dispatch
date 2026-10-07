#!/usr/bin/env node
// Sign or verify a Sparkle 2.10 signed appcast without the macOS toolchain.
//
//   sign:   stdin = unsigned feed bytes, stdout = signed feed bytes
//   verify: stdin = signed feed bytes, exit 0 only if the signature is valid
//   verify-archive <archive> <edSignature>: check an enclosure signature
//
// Format (Sparkle common_cli/Signing.swift signAppcast, SPUExtractSignedFeed.m):
// the Ed25519 signature covers every byte before the trailing block
//   <!-- sparkle-signatures:\nedSignature: <base64>\nlength: <bytes>\n-->\n
// Keys come only from the environment (MACOS_SPARKLE_PRIVATE_KEY, a base64
// 32-byte seed, and DISPATCH_SPARKLE_PUBLIC_KEY); they never enter argv,
// logs, or files.
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";

const PREFIX = Buffer.from("<!-- sparkle-signatures:\n");
const KEY = /^[A-Za-z0-9+/]{43}=$/;

function publicKey() {
  const value = process.env.DISPATCH_SPARKLE_PUBLIC_KEY ?? "";
  if (!KEY.test(value))
    throw new Error("DISPATCH_SPARKLE_PUBLIC_KEY must be a base64 Ed25519 key");
  return createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(value, "base64"),
    ]),
    format: "der",
    type: "spki",
  });
}

function privateKey(expected) {
  const seed = process.env.MACOS_SPARKLE_PRIVATE_KEY ?? "";
  if (!KEY.test(seed))
    throw new Error("Expected a base64 32-byte private seed");
  const key = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(seed, "base64"),
    ]),
    format: "der",
    type: "pkcs8",
  });
  const derived = createPublicKey(key).export({ format: "der", type: "spki" });
  if (!derived.equals(expected.export({ format: "der", type: "spki" })))
    throw new Error(
      "Sparkle private seed does not match configured public key"
    );
  return key;
}

// Strict inverse of signAppcast: exactly one trailing block, nothing after it.
function split(data) {
  const at = data.lastIndexOf(PREFIX);
  if (at < 0 || data.indexOf(PREFIX) !== at) return null;
  const block = data.subarray(at).toString("utf8");
  const match =
    /^<!-- sparkle-signatures:\nedSignature: ([A-Za-z0-9+/]{86}==)\nlength: ([1-9][0-9]*)\n-->\n$/.exec(
      block
    );
  if (!match) return null;
  return {
    content: data.subarray(0, at),
    signature: Buffer.from(match[1], "base64"),
    length: Number(match[2]),
  };
}

function signFeed(content, key, expected) {
  if (content.includes(PREFIX)) throw new Error("Feed is already signed");
  const signature = sign(null, content, key);
  if (!verify(null, content, expected, signature))
    throw new Error("Feed signature self-check failed");
  return Buffer.concat([
    content,
    Buffer.from(
      `<!-- sparkle-signatures:\nedSignature: ${signature.toString("base64")}\nlength: ${content.length}\n-->\n`
    ),
  ]);
}

function verifyFeed(data, expected) {
  const parts = split(data);
  return (
    parts !== null &&
    parts.length === parts.content.length &&
    verify(null, parts.content, expected, parts.signature)
  );
}

const [mode, archive, signature] = process.argv.slice(2);
try {
  const expected = publicKey();
  if (mode === "sign") {
    process.stdout.write(
      signFeed(readFileSync(0), privateKey(expected), expected)
    );
  } else if (mode === "verify-archive") {
    if (
      !/^[A-Za-z0-9+/]{86}==$/.test(signature ?? "") ||
      !verify(
        null,
        readFileSync(archive),
        expected,
        Buffer.from(signature, "base64")
      )
    ) {
      console.error("Archive signature is invalid");
      process.exit(1);
    }
  } else if (mode === "verify") {
    if (!verifyFeed(readFileSync(0), expected)) {
      console.error("Appcast feed signature is invalid");
      process.exit(1);
    }
  } else {
    throw new Error(
      "Usage: sparkle-feed-signature.mjs sign|verify < feed, or verify-archive <archive> <signature>"
    );
  }
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
