import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { FlowStreams } from "../src/v1/streams.js";
import { blobPathFrame, socketRequest } from "../src/transport/local-socket.js";

describe("path-blob frame", () => {
  const frame = { type: "blob", id: "blob-1", path: "/etc/hosts" };

  it("is a local socket frame", () => {
    expect(blobPathFrame.check(frame)).toBe(true);
  });

  const inPlace = { ...frame, inPlace: { mustExist: false } };

  it.each([
    ["a path", frame],
    ["a path in place", inPlace],
  ])("is refused on the enrolled transport (%s)", (_name, sent) => {
    expect(socketRequest.check(sent)).toBe(false);
    const socket = new PassThrough();
    const streams = new FlowStreams(socket, () => {});
    streams.enable();
    expect(streams.handle(sent)).toBe(false);
    socket.destroy();
  });

  it("takes the in-place mark only in its shape", () => {
    expect(blobPathFrame.check(inPlace)).toBe(true);
    expect(
      blobPathFrame.check({ ...frame, inPlace: { mustExist: "yes" } })
    ).toBe(false);
  });
});
