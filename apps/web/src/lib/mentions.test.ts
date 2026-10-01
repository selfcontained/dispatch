import { qualifyExternalMentions } from "@dispatch/shared";
import { describe, expect, it } from "vitest";

import {
  insertMention,
  matchMentionables,
  mentionQueryAt,
  mentionSpans,
} from "./mentions";

const agents = [
  { id: "agt_p", name: "badge demo parent", seat: 1 },
  { id: "agt_c", name: "badge demo", seat: 2 },
  { id: "agt_r", name: "reviewer", seat: 3 },
];

describe("mentionQueryAt", () => {
  it("finds the @query the caret sits in, spaces included", () => {
    expect(mentionQueryAt("hi @rev", 7)).toEqual({ start: 3, query: "rev" });
    expect(mentionQueryAt("@badge de", 9)).toEqual({
      start: 0,
      query: "badge de",
    });
    expect(mentionQueryAt("@", 1)).toEqual({ start: 0, query: "" });
  });

  it("is null in plain text, inside an email, or past a line break", () => {
    expect(mentionQueryAt("hello", 5)).toBeNull();
    expect(mentionQueryAt("me@example", 10)).toBeNull();
    expect(mentionQueryAt("@rev\nmore", 9)).toBeNull();
  });
});

describe("matchMentionables", () => {
  it("lists everyone for an empty query, then filters by name or seat", () => {
    expect(matchMentionables("", agents)).toHaveLength(3);
    expect(matchMentionables("REV", agents).map((a) => a.id)).toEqual([
      "agt_r",
    ]);
    expect(matchMentionables("2", agents).map((a) => a.id)).toEqual(["agt_c"]);
    expect(matchMentionables("badge", agents).map((a) => a.id)).toEqual([
      "agt_p",
      "agt_c",
    ]);
  });
});

describe("insertMention", () => {
  it("replaces the token with @Name and a space, caret after it", () => {
    expect(insertMention("ask @rev about it", 4, 8, agents[2]!)).toEqual({
      text: "ask @reviewer about it",
      caret: 14,
    });
  });
});

describe("mentionSpans", () => {
  it("paints known names, longest first, and leaves the rest as text", () => {
    expect(
      mentionSpans("@badge demo parent and @reviewer: go", agents)
    ).toEqual([
      { kind: "mention", text: "@badge demo parent", agent: agents[0] },
      { kind: "text", text: " and " },
      { kind: "mention", text: "@reviewer", agent: agents[2] },
      { kind: "text", text: ": go" },
    ]);
    expect(mentionSpans("no mentions", agents)).toEqual([
      { kind: "text", text: "no mentions" },
    ]);
    expect(mentionSpans("@nobody", agents)).toEqual([
      { kind: "text", text: "@nobody" },
    ]);
  });
});

describe("qualified external mentions", () => {
  it("keeps duplicate selections distinct in insertion and preview", () => {
    const external = qualifyExternalMentions(
      [],
      [
        { id: "agt_old", name: "Duplicate" },
        { id: "agt_new", name: "duplicate" },
      ]
    );
    for (const agent of external) {
      const draft = insertMention("@", 0, 1, agent).text;
      expect(mentionSpans(draft, external)).toEqual([
        { kind: "mention", text: `@${agent.mentionName}`, agent },
        { kind: "text", text: " " },
      ]);
    }
    expect(mentionSpans("@Duplicate help", external)).toEqual([
      { kind: "text", text: "@Duplicate help" },
    ]);
  });

  it("protects a tree name at word boundaries and allows explicit external selection", () => {
    const tree = [{ id: "own", name: "Review" }];
    const external = qualifyExternalMentions(tree, [
      { id: "other", name: "Review fix" },
      { id: "unrelated", name: "Reviewer" },
    ]);
    expect(external[1]!.mentionName).toBeUndefined();
    const candidates = [...tree, ...external];
    expect(mentionSpans("@Review fix the test", candidates)[0]).toMatchObject({
      agent: tree[0],
    });
    const draft = insertMention("@", 0, 1, external[0]!).text;
    expect(mentionSpans(draft, candidates)[0]).toMatchObject({
      agent: external[0],
    });
  });
});

it("keeps qualified identity valid after another same-name session disappears", () => {
  const before = qualifyExternalMentions(
    [],
    [
      { id: "old", name: "Duplicate" },
      { id: "new", name: "Duplicate" },
    ]
  );
  const draft = insertMention("@", 0, 1, before[1]!).text;
  const after = qualifyExternalMentions([], [{ id: "new", name: "Duplicate" }]);
  expect(after[0]!.mentionName).toBeUndefined();
  expect(mentionSpans(draft, after)[0]).toMatchObject({ agent: { id: "new" } });
});
