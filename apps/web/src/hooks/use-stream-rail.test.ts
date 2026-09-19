// @vitest-environment jsdom
import type { StreamEntry } from "@dispatch/shared";
import { describe, expect, it } from "vitest";

import {
  answered,
  block,
  blockEntry,
  formBody,
  questionBody,
} from "@/test-utils/blocks";

import { deriveStreamRail, isOpenInput } from "./use-stream-rail";

const ROOT = "agt_root";
const CHILD = "agt_child";
const at = (hhmm: string): string => `2026-09-19T${hhmm}:00.000Z`;

function question(id: string, by: string, when: string, done = false) {
  const options = [{ label: "Yes" }, { label: "No" }];
  return blockEntry(
    block({
      id,
      author: { kind: "agent", agentId: by },
      text: `Q ${id}?`,
      body: questionBody(options, done ? { state: answered("Yes") } : {}),
      createdAt: when,
    })
  );
}

function link(id: string, by: string, when: string, url: string) {
  return blockEntry(
    block({
      id,
      author: { kind: "agent", agentId: by },
      body: { kind: "link", data: { url, title: id }, state: null },
      createdAt: when,
    })
  );
}

describe("isOpenInput", () => {
  it("is an agent's unanswered question or form for people", () => {
    expect(isOpenInput(question("q", ROOT, at("10:00")).block)).toBe(true);
    expect(isOpenInput(question("q", ROOT, at("10:00"), true).block)).toBe(
      false
    );
    expect(
      isOpenInput(
        block({
          author: { kind: "agent", agentId: ROOT },
          body: formBody([{ id: "f", label: "F", type: "text" }]),
        })
      )
    ).toBe(true);
    // Addressed to another agent: that agent answers, not the user.
    expect(
      isOpenInput({
        ...question("q", ROOT, at("10:00")).block,
        toAgentId: CHILD,
      })
    ).toBe(false);
    expect(isOpenInput(block({ text: "hi" }))).toBe(false);
  });
});

describe("deriveStreamRail", () => {
  const entries: StreamEntry[] = [
    question("q1", ROOT, at("10:00")),
    question("q2", CHILD, at("10:01")),
    question("q3", ROOT, at("10:02"), true),
    link("l1", ROOT, at("10:03"), "https://example.com/a"),
    link("l2", CHILD, at("10:04"), "https://github.com/o/r/pull/7"),
    link("l3", ROOT, at("10:05"), "https://example.com/a"),
    blockEntry(
      block({
        id: "p1",
        author: { kind: "agent", agentId: ROOT },
        text: "see",
        attachments: [{ type: "pr", url: "https://github.com/o/r/pull/8" }],
        createdAt: at("10:06"),
      })
    ),
    {
      type: "status",
      id: "s1",
      eventType: "working",
      message: "",
      at: at("10:07"),
    },
  ];

  it("lists every open input in the stream on the root's page, oldest first", () => {
    const rail = deriveStreamRail(entries, ROOT, ROOT);
    expect(rail.inputs.map((b) => b.id)).toEqual(["q1", "q2"]);
  });

  it("lists only the child's own inputs and links on a child's page", () => {
    const rail = deriveStreamRail(entries, CHILD, ROOT);
    expect(rail.inputs.map((b) => b.id)).toEqual(["q2"]);
    expect(rail.links.map((l) => l.url)).toEqual([
      "https://github.com/o/r/pull/7",
    ]);
    expect(rail.links[0]?.pr).toBe(true);
  });

  it("lists links newest first, once per url, marking pull requests", () => {
    const rail = deriveStreamRail(entries, ROOT, ROOT);
    expect(rail.links.map((l) => [l.url, l.pr])).toEqual([
      ["https://github.com/o/r/pull/8", true],
      ["https://example.com/a", false],
      ["https://github.com/o/r/pull/7", true],
    ]);
    // The newest block with a repeated url is the one kept.
    expect(rail.links[1]?.blockId).toBe("l3");
  });
});
