import { writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FlowStreams } from "@dispatch/runner-client/v1/node";
import { receiveCheckoutRead } from "@dispatch/runner-client/v1/connection";
import { parseServiceFrame } from "@dispatch/runner-protocol";
import { sessionFromWire, type Req } from "@dispatch/runner-protocol/contract";
import { runnerDirectory } from "../src/runners/directory.js";
import { placementForRunner } from "../src/runners/placement.js";
import type { RemoteRunnerService } from "../src/agents/remote/service.js";
import { checkoutWorkload } from "./helpers/checkout-workload.js";
import { ownedCheckoutFixture } from "./helpers/owned-checkout-fixture.js";
let fixture: Awaited<ReturnType<typeof ownedCheckoutFixture>>;
beforeAll(async () => {
  fixture = await ownedCheckoutFixture(checkoutWorkload);
  await writeFile(path.join(fixture.worktree, "owned-only"), "x");
  await writeFile(path.join(fixture.moved, "selected-only"), "x");
});
afterAll(async () => {
  await fixture?.close();
});
async function probe(checkout: "current" | "launch" | "owned", file: string) {
  const row = fixture.rows.find((row) => row.name === "moved-repository")!;
  const socket = new PassThrough(),
    peerSocket = new PassThrough();
  const client = new FlowStreams(socket, (frame, flushed) =>
    queueMicrotask(() => {
      peer.handle(frame);
      flushed?.();
    })
  );
  const peer = new FlowStreams(peerSocket, (frame, flushed) =>
    queueMicrotask(() => {
      client.handle(frame);
      flushed?.();
    })
  );
  client.enable();
  peer.enable();
  let wire: unknown;
  const service = {
    streamCheckoutRead(
      _placement: unknown,
      op: "checkout.access",
      input: Req<"checkout.access">,
      signal?: AbortSignal
    ) {
      return receiveCheckoutRead(
        op,
        input,
        "configured",
        async (command, active) => {
          wire = {
            type: "request",
            id: "probe",
            command: {
              ...command,
              operation: { ...command.operation, streamId: "stream" },
            },
          };
          expect(parseServiceFrame(wire)).toEqual(wire);
          if (command.operation.op !== "checkout.access")
            throw new Error("Wrong operation");
          const data = await fixture.access(
            row,
            command.operation.checkout ?? "current",
            command.operation.request
          );
          await peer.send(
            command.operation.streamId,
            Readable.from([Buffer.from(JSON.stringify({ data }))]),
            active
          );
          return { value: true };
        },
        client,
        signal
      );
    },
    requestSession() {
      throw new Error("No legacy access carrier.");
    },
  } as unknown as RemoteRunnerService;
  const placement = placementForRunner("rnr_access");
  try {
    const data = await runnerDirectory(
      { remote: service },
      { ...row, cwd: "runner://rnr_access/configured", placement }
    )
      .for(placement)
      .call("checkout.access", {
        target: { session: sessionFromWire(row.id), checkout },
        path: file,
      });
    return { data, wire };
  } finally {
    socket.destroy();
    peerSocket.destroy();
  }
}
it.each(["current", "launch", "owned"] as const)(
  "round-trips boolean probes for %s",
  async (selector) => {
    expect((await probe(selector, "owned-only")).data).toBe(
      selector !== "current"
    );
    expect((await probe(selector, "selected-only")).data).toBe(
      selector === "current"
    );
  }
);
it("carries owned on the existing launch stream and omits current", async () => {
  const owned = await probe("owned", "owned-only"),
    launch = await probe("launch", "owned-only"),
    current = await probe("current", "owned-only");
  expect(owned.wire).toEqual(launch.wire);
  expect(JSON.stringify(current.wire)).toBe(
    '{"type":"request","id":"probe","command":{"kind":"checkoutRead","workspace":"configured","agentId":"agt_owned2","operation":{"op":"checkout.access","request":{"path":"owned-only"},"streamId":"stream"}}}'
  );
});
it("refuses a peer without streaming without sending a legacy request", async () => {
  let legacy = 0;
  const placement = placementForRunner("rnr_access"),
    row = fixture.rows[0]!;
  const service = {
    requestSession() {
      legacy++;
      throw new Error("Unexpected legacy request");
    },
  } as unknown as RemoteRunnerService;
  await expect(
    runnerDirectory(
      { remote: service },
      { ...row, cwd: "runner://rnr_access/configured", placement }
    )
      .for(placement)
      .call("checkout.access", {
        target: { session: sessionFromWire(row.id) },
        path: "file",
      })
  ).rejects.toMatchObject({ code: "unsupported" });
  expect(legacy).toBe(0);
});
