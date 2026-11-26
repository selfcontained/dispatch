import { afterAll, beforeAll, expect, it } from "vitest";
import { checkoutWorkload } from "./helpers/checkout-workload.js";
import {
  ownedCheckoutFixture,
  ownerEvidence,
  ownerReply,
} from "./helpers/owned-checkout-fixture.js";
let fixture: Awaited<ReturnType<typeof ownedCheckoutFixture>>;
beforeAll(async () => {
  fixture = await ownedCheckoutFixture(checkoutWorkload);
  await fixture.finalizeGone();
});
afterAll(async () => {
  await fixture?.close();
});
const cases = [
  ["worktree", { "worktree-owner": 1 }],
  ["no-worktree", { "main-owner": 1 }],
  ["moved-repository", { "moved-owner": 1 }],
  ["moved-subfolder", { "moved-owner": 1 }],
  ["gone-worktree", {}],
  ["non-repository", { "folder-owner": 1 }],
] as const;
it.each(cases)(
  "pins old enrolled assessment and main's desired owned output: %s",
  async (name, old) => {
    const row = fixture.rows.find((r) => r.name === name)!;
    expect(await fixture.main(row)).toEqual(row.expected);
    const read = async (selector: "current" | "launch") =>
      ownerEvidence(
        await fixture
          .read(row, selector)
          .then(ownerReply)
          .catch(() => null)
      );
    expect(await read("current")).toEqual(old);
    // Existing enrolled launch is the immutable checkout that owned will name.
    expect(await read("launch")).toEqual(row.expected);
    expect(await fixture.stored(row)).toBe(row.home);
  }
);
it("keeps owned/current roots after supervisor resume from persisted bindings", async () => {
  await fixture.restart();
  for (const [name, old] of cases) {
    const row = fixture.rows.find((r) => r.name === name)!;
    expect(
      ownerEvidence(
        await fixture
          .read(row, "current")
          .then(ownerReply)
          .catch(() => null)
      )
    ).toEqual(old);
    expect(
      ownerEvidence(
        await fixture
          .read(row, "launch")
          .then(ownerReply)
          .catch(() => null)
      )
    ).toEqual(row.expected);
  }
});

it.each(cases)(
  "streams owned via unchanged enrolled launch bytes: %s",
  async (name) => {
    const row = fixture.rows.find((r) => r.name === name)!;
    const owned = await streamed(row, "owned");
    const launch = await streamed(row, "launch");
    expect(ownerEvidence(owned.reply)).toEqual(row.expected);
    expect(owned.wire).toBe(launch.wire);
  }
);

import { PassThrough, Readable } from "node:stream";
import { FlowStreams } from "@dispatch/runner-client/v1/node";
import { receiveCheckoutRead } from "@dispatch/runner-client/v1/connection";
import { sessionFromWire, type Req } from "@dispatch/runner-protocol/contract";
import { runnerDirectory } from "../src/runners/directory.js";
import { placementForRunner } from "../src/runners/placement.js";
import type { RemoteRunnerService } from "../src/agents/remote/service.js";
async function streamed(
  row: (typeof fixture.rows)[number],
  checkout: "owned" | "launch"
) {
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
  let wire: string | undefined;
  const service = {
    streamCheckoutRead(
      _placement: unknown,
      op: "checkout.read",
      input: Req<"checkout.read">,
      signal?: AbortSignal
    ) {
      return receiveCheckoutRead(
        op,
        input,
        "configured",
        async (command, active) => {
          wire = JSON.stringify({
            ...command,
            operation: { ...command.operation, streamId: "stream" },
          });
          if (command.operation.op !== "checkout.read")
            throw new Error("Wrong read family.");
          const data = await fixture.read(
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
      throw new Error("Owned reads have no legacy fallback.");
    },
  } as unknown as RemoteRunnerService;
  const placement = placementForRunner("rnr_owned");
  const agent = { ...row, cwd: "runner://rnr_owned/configured", placement };
  try {
    const reply = await runnerDirectory({ remote: service }, agent)
      .for(placement)
      .call("checkout.read", {
        target: { session: sessionFromWire(row.id), checkout },
        path: ".agents/owners.json",
        encoding: "utf8",
        maxBytes: null,
      })
      .then(ownerReply)
      .catch(() => null);
    expect(wire).toContain('"checkout":"launch"');
    return { reply, wire };
  } finally {
    socket.destroy();
    peerSocket.destroy();
  }
}

it("does not send owned to a peer without checkout read streaming", async () => {
  let legacy = 0;
  const service = {
    requestSession() {
      legacy++;
      throw new Error("Unexpected legacy read.");
    },
  } as unknown as RemoteRunnerService;
  const placement = placementForRunner("rnr_owned"),
    row = fixture.rows[0]!;
  const agent = { ...row, cwd: "runner://rnr_owned/configured", placement };
  await expect(
    runnerDirectory({ remote: service }, agent)
      .for(placement)
      .call("checkout.read", {
        target: { session: sessionFromWire(row.id), checkout: "owned" },
        path: ".agents/owners.json",
        encoding: "utf8",
        maxBytes: null,
      })
  ).rejects.toMatchObject({ code: "unsupported" });
  expect(legacy).toBe(0);
});
