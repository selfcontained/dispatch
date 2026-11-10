import { describe, it, expect } from "vitest";
import type { Block } from "@dispatch/shared";
import {
  messageContent,
  messageExcerpt,
  automaticExcerpt,
} from "../src/chat/context.js";
import { sharedMessageSnapshot } from "../src/chat/message-shares.js";
const metric = {
  version: 1,
  title: "Latency",
  unit: "ms",
  dataKind: "measured",
  value: 42,
};
const make = (kind: string, data: unknown) =>
  ({
    id: "00000000-0000-4000-8000-000000000001",
    streamId: "agent",
    author: { kind: "agent", agentId: "agent" },
    kind,
    data,
    text: "",
    state: null,
    attachments: [],
    threadId: null,
    replyTo: null,
    createdAt: "2026-11-10",
    updatedAt: "2026-11-10",
  }) as Block;
describe("visualization history and immutable public snapshots", () => {
  it.each(["metric", "chart", "visualization_group"])(
    "preserves textless %s public data without service metadata",
    (kind) => {
      const chart = {
        version: 1,
        title: "Latency",
        unit: "ms",
        dataKind: "measured",
        type: "line",
        xLabel: "Time",
        series: [{ id: "latency", label: "Latency", color: "cyan" }],
        points: [{ label: "Now", values: [42] }],
      };
      const data =
        kind === "metric"
          ? metric
          : kind === "chart"
            ? chart
            : {
                version: 1,
                title: "Summary",
                items: [{ kind: "metric", data: metric }],
              };
      const block = make(kind, {
        ...data,
        delivery: "queue",
        internalSecret: "private",
      });
      expect(JSON.parse(messageContent(block))).toEqual(data);
      expect(sharedMessageSnapshot(block).data).toEqual(data);
      expect(automaticExcerpt(block, "parent", 4000)).toContain("Latency");
      expect(messageContent(block)).not.toMatch(
        /delivery|internalSecret|private/
      );
    }
  );
  it("reassembles every value through paginated chart reads", () => {
    const data = {
      version: 1,
      title: "Latency",
      unit: "ms",
      dataKind: "measured",
      type: "line",
      xLabel: "Sample",
      series: [{ id: "latency", label: "Latency", color: "cyan" }],
      points: Array.from({ length: 200 }, (_, i) => ({
        label: `Sample ${i}`,
        values: [i + 0.125],
      })),
    };
    const block = make("chart", data);
    let offset = 0;
    let content = "";
    let pages = 0;
    while (true) {
      const page = messageExcerpt(block, offset, 80);
      content += page.content;
      pages++;
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    expect(pages).toBeGreaterThan(1);
    expect(JSON.parse(content)).toEqual(data);
  });
});
