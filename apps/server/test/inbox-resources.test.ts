import { describe, expect, it } from "vitest";
import { isInboxResource, resourcesOf, type Block } from "@dispatch/shared";

const resource = (overrides: Partial<Block> = {}): Block =>
  ({
    id: "post",
    streamId: "root",
    author: { kind: "agent", agentId: "root" },
    toAgentId: null,
    threadId: null,
    replyTo: null,
    text: "",
    kind: "text",
    data: null,
    state: null,
    attachments: [],
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    readAt: null,
    delivered: null,
    ...overrides,
  }) as Block;

describe("shared inbox resource contract", () => {
  it("recognizes explicit resources and legacy PR links without inferring previews", () => {
    const block = resource({
      attachments: [
        {
          type: "link",
          url: "http://192.168.1.2:4321",
          title: "Preview in name only",
        },
        { type: "link", url: "https://github.com/o/r/pull/1" },
        { type: "link", url: "https://gitlab.test/o/r/merge_requests/2" },
        { type: "pr", url: "https://other.test/review/3" },
        { type: "preview", url: "/app", title: "App" },
      ],
    });
    expect(resourcesOf(block).map((r) => [r.kind, r.url])).toEqual([
      ["pr", "https://github.com/o/r/pull/1"],
      ["pr", "https://gitlab.test/o/r/merge_requests/2"],
      ["pr", "https://other.test/review/3"],
      ["preview", "/app"],
    ]);
    expect(
      resourcesOf(
        resource({
          kind: "link",
          data: { url: "https://github.com/o/r/pull/5", title: "Legacy" },
        })
      )
    ).toEqual([
      { kind: "pr", url: "https://github.com/o/r/pull/5", title: "Legacy" },
    ]);
  });

  it("preserves same-stream root visibility and child authorship without expanding identity scope", () => {
    const child = resource({
      author: { kind: "agent", agentId: "child" },
      threadId: "launch",
      toAgentId: "peer",
      attachments: [
        { type: "preview", url: "https://example.com", title: "App" },
      ],
    });
    expect(isInboxResource(child, "root", false)).toBe(true);
    expect(isInboxResource(child, "root", true)).toBe(true);
    expect(isInboxResource(child, "root", "child")).toBe(true);
    expect(isInboxResource(child, "root", "sibling")).toBe(false);
    expect(isInboxResource(child, "other", true)).toBe(false);
    expect(
      isInboxResource({ ...child, author: { kind: "user" } }, "root", "child")
    ).toBe(false);
    expect(
      isInboxResource(
        {
          ...child,
          attachments: [{ type: "link", url: "https://example.com" }],
        },
        "root",
        true
      )
    ).toBe(false);
  });
});
