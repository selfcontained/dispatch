/*
 * The path-blob frame belongs to the local socket only. On TLS/v1 it is not
 * a service frame, has no request ID and is not a stream frame, so the v1
 * runner's dispatch (`agents/remote/runner.ts`: not parsed, no request ID →
 * destroy) drops the connection instead of reading a path.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseServiceFrame, runnerRequestId } from "@dispatch/runner-protocol";
import { FlowStreams } from "../src/v1/streams.js";
import { blobPathFrame } from "../src/transport/local-socket.js";

describe("path-blob frame", () => {
  const frame = { type: "blob", id: "blob-1", path: "/etc/hosts" };

  it("is a local socket frame", () => {
    expect(blobPathFrame.check(frame)).toBe(true);
  });

  it("is refused on the TLS/v1 transport", () => {
    expect(parseServiceFrame(frame)).toBeNull();
    expect(runnerRequestId(frame)).toBeUndefined();
    const socket = new PassThrough();
    const streams = new FlowStreams(socket, () => {});
    streams.enable();
    expect(streams.handle(frame)).toBe(false);
    socket.destroy();
  });
});
