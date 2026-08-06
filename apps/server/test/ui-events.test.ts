import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";

import { UiEventBroker } from "../src/server/ui-events.js";

function createWritableStream() {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (chunk) => chunks.push(chunk.toString()));
  return { stream, chunks };
}

describe("UiEventBroker", () => {
  it("has no connected clients initially", () => {
    const broker = new UiEventBroker();
    expect(broker.hasConnectedClient()).toBe(false);
  });

  it("tracks connected clients after subscribe", () => {
    const broker = new UiEventBroker();
    const { stream } = createWritableStream();
    broker.subscribe(stream);
    expect(broker.hasConnectedClient()).toBe(true);
  });

  it("unsubscribe removes the client", () => {
    const broker = new UiEventBroker();
    const { stream } = createWritableStream();
    const unsub = broker.subscribe(stream);
    expect(broker.hasConnectedClient()).toBe(true);
    unsub();
    expect(broker.hasConnectedClient()).toBe(false);
  });

  it("publishes events to all subscribed clients", () => {
    const broker = new UiEventBroker();
    const c1 = createWritableStream();
    const c2 = createWritableStream();
    broker.subscribe(c1.stream);
    broker.subscribe(c2.stream);

    broker.publish({ type: "job.changed" });

    expect(c1.chunks).toHaveLength(1);
    expect(c2.chunks).toHaveLength(1);
    expect(c1.chunks[0]).toContain('"type":"job.changed"');
    expect(c2.chunks[0]).toContain('"type":"job.changed"');
  });

  it("formats events as SSE with id and data fields", () => {
    const broker = new UiEventBroker();
    const { stream, chunks } = createWritableStream();
    broker.subscribe(stream);

    broker.publish({ type: "template.changed" });

    const message = chunks[0];
    expect(message).toMatch(/^id: \d+\n/);
    expect(message).toContain("data: ");
    expect(message).toMatch(/\n\n$/);
  });

  it("increments the event id across publishes", () => {
    const broker = new UiEventBroker();
    const { stream, chunks } = createWritableStream();
    broker.subscribe(stream);

    broker.publish({ type: "job.changed" });
    broker.publish({ type: "template.changed" });

    const id1 = chunks[0].match(/^id: (\d+)/)?.[1];
    const id2 = chunks[1].match(/^id: (\d+)/)?.[1];
    expect(Number(id2)).toBeGreaterThan(Number(id1));
  });

  it("does not send to unsubscribed clients", () => {
    const broker = new UiEventBroker();
    const { stream, chunks } = createWritableStream();
    const unsub = broker.subscribe(stream);
    unsub();

    broker.publish({ type: "job.changed" });

    expect(chunks).toHaveLength(0);
  });

  it("removes clients that throw on write", () => {
    const broker = new UiEventBroker();
    const badStream = {
      write: vi.fn().mockImplementation(() => {
        throw new Error("broken pipe");
      }),
    } as unknown as NodeJS.WritableStream;
    const good = createWritableStream();

    broker.subscribe(badStream);
    broker.subscribe(good.stream);

    broker.publish({ type: "job.changed" });

    expect(good.chunks).toHaveLength(1);
    expect(broker.hasConnectedClient()).toBe(true);

    broker.publish({ type: "template.changed" });
    expect(good.chunks).toHaveLength(2);
  });

  it("sendSnapshot writes only to the target stream", () => {
    const broker = new UiEventBroker();
    const c1 = createWritableStream();
    const c2 = createWritableStream();
    broker.subscribe(c1.stream);
    broker.subscribe(c2.stream);

    broker.sendSnapshot(c1.stream, []);

    expect(c1.chunks).toHaveLength(1);
    expect(c1.chunks[0]).toContain('"type":"snapshot"');
    expect(c2.chunks).toHaveLength(0);
  });

  it("sendSnapshot includes agents in the payload", () => {
    const broker = new UiEventBroker();
    const { stream, chunks } = createWritableStream();
    broker.subscribe(stream);

    const fakeAgent = { id: "agt_test123", name: "test" } as any;
    broker.sendSnapshot(stream, [fakeAgent]);

    const data = chunks[0].split("data: ")[1].replace(/\n\n$/, "");
    const parsed = JSON.parse(data);
    expect(parsed.type).toBe("snapshot");
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0].id).toBe("agt_test123");
  });

  it("buffers events until the initial snapshot is sent", () => {
    const broker = new UiEventBroker();
    const { stream, chunks } = createWritableStream();
    broker.subscribe(stream, { bufferUntilSnapshot: true });

    broker.publish({
      type: "agent.upsert",
      agent: { id: "agt_new" } as any,
    });

    expect(chunks).toHaveLength(0);

    broker.sendSnapshot(stream, []);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('"type":"snapshot"');
    expect(chunks[1]).toContain('"type":"agent.upsert"');
    expect(chunks[1]).toContain('"id":"agt_new"');
  });

  it("flushes buffered events in order after the snapshot", () => {
    const broker = new UiEventBroker();
    const { stream, chunks } = createWritableStream();
    broker.subscribe(stream, { bufferUntilSnapshot: true });

    broker.publish({ type: "job.changed" });
    broker.publish({ type: "template.changed" });
    broker.sendSnapshot(stream, []);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toContain('"type":"snapshot"');
    expect(chunks[1]).toContain('"type":"job.changed"');
    expect(chunks[2]).toContain('"type":"template.changed"');
  });

  it("can release buffered events when a snapshot cannot be loaded", () => {
    const broker = new UiEventBroker();
    const { stream, chunks } = createWritableStream();
    broker.subscribe(stream, { bufferUntilSnapshot: true });

    broker.publish({ type: "agent.deleted", agentId: "agt_old" });
    broker.flushSnapshot(stream);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('"type":"agent.deleted"');

    broker.publish({ type: "job.changed" });
    expect(chunks).toHaveLength(2);
  });
});
