// Production runs the server on Bun, whose zlib differs from Node's in
// what a one-shot decode returns for a torn or multi-frame buffer. The
// vitest suite runs on Node; this smoke test exercises the same decoder
// under Bun: `bun apps/server/test/bun-session-log.smoke.ts`.
import { constants, zstdCompressSync } from "node:zlib";

import {
  decodeZstdFrames,
  decodeZstdFramesAsync,
  parseSessionLog,
  zstdFrameLength,
} from "../src/agents/dsh/session-log.ts";

const CHECKSUM = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const frames = (batches: string[]) =>
  Buffer.concat(batches.map((b) => zstdCompressSync(b, CHECKSUM)));

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}

const header = '{"type":"session","id":"s1"}\n';
const a = frames([header]);
const big = frames([`{"type":"a","pad":"${"x".repeat(200_000)}"}\n`]);
const rest = frames(['{"type":"b"}\n', '{"type":"c"}\n']);
const whole = Buffer.concat([a, big, rest]);
assert(zstdFrameLength(whole, 0) === a.length, "first frame length");
assert(zstdFrameLength(whole, a.length) === big.length, "second frame length");

const full = parseSessionLog(decodeZstdFrames(whole));
assert(full.header?.id === "s1", "header parsed");
assert(
  full.events.map((e) => e.type).join() === "a,b,c",
  `all frames decoded, got ${full.events.map((e) => e.type).join()}`
);

const torn = parseSessionLog(
  await decodeZstdFramesAsync(whole.subarray(0, whole.length - 5))
);
assert(torn.header?.id === "s1", "torn: header survives");
assert(
  torn.events.some((e) => e.type === "a"),
  "torn: earlier frames survive"
);

const corrupt = Buffer.from(whole);
corrupt[a.length + 12] ^= 0x55;
const skipped = parseSessionLog(decodeZstdFrames(corrupt));
assert(
  skipped.events.map((e) => e.type).join() === "b,c",
  `corrupt frame skipped, got ${skipped.events.map((e) => e.type).join()}`
);
console.log(
  `ok: session-log decoder under ${typeof Bun !== "undefined" ? `bun ${Bun.version}` : process.version}`
);
