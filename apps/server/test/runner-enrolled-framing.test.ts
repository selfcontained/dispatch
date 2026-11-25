import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import {
  legacy,
  results,
  statuses,
  updates,
} from "../../../packages/runner-client/test/v1-fixtures.js";
import { wireFrames } from "../src/runners/enrolled/v1-framing.js";

it("writes and reads the enrolled adapter's v1 frames as UTF-8 JSON lines", () => {
  const frames = [
    ...legacy.map((command) => ({ type: "request", id: "legacy", command })),
    ...results.flatMap(({ command, value }, index) => [
      { type: "request", id: String(index), command },
      { type: "result", id: String(index), value },
    ]),
    ...updates,
    ...statuses,
  ];
  const socket = new PassThrough();
  const chunks: Buffer[] = [];
  const received: unknown[] = [];
  socket.on("data", (bytes: Buffer) => chunks.push(bytes));
  const send = wireFrames<unknown, unknown>(socket, (frame) =>
    received.push(frame)
  );
  try {
    for (const frame of frames) send(frame);
    const expected = frames
      .map((frame) => JSON.stringify(frame) + "\n")
      .join("");
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(expected));
    expect(received).toEqual(frames);
  } finally {
    socket.destroy();
  }
});
