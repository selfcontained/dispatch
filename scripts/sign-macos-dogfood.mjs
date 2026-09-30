#!/usr/bin/env node
// The private seed never enters argv, logs, or an artifact directory.
import { createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const [archive, output] = process.argv.slice(2);
const seed = process.env.MACOS_SPARKLE_PRIVATE_KEY ?? '';
const publicKey = process.env.DISPATCH_SPARKLE_PUBLIC_KEY ?? '';
if (!/^[A-Za-z0-9+/]{43}=$/.test(seed)) throw new Error('Expected a base64 32-byte private seed');
const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed, 'base64')]), format: 'der', type: 'pkcs8' });
const publicObject = createPublicKey(key);
if (publicObject.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') !== publicKey)
  throw new Error('Sparkle private seed does not match configured public key');
const scratch = mkdtempSync(path.join(tmpdir(), 'dispatch-sparkle-key-'));
chmodSync(scratch, 0o700);
try {
  const keyFile = path.join(scratch, 'seed');
  writeFileSync(keyFile, seed, { mode: 0o600 });
  const env = { ...process.env };
  delete env.MACOS_SPARKLE_PRIVATE_KEY;
  const result = spawnSync(path.join(process.env.DISPATCH_SPARKLE_SDK, 'bin/sign_update'), ['--ed-key-file', keyFile, '-p', archive], { encoding: 'utf8', env });
  if (result.error || result.status !== 0) throw new Error('Sparkle archive signing failed');
  const signature = result.stdout.trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature) || !verify(null, readFileSync(archive), publicObject, Buffer.from(signature, 'base64')))
    throw new Error('Sparkle archive signature verification failed');
  writeFileSync(output, signature + '\n');
} finally { rmSync(scratch, { recursive: true, force: true }); }
