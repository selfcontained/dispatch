import { describe, expect, it } from "vitest";

import { findMentions } from "../src/chat/mentions.js";

const agents = [
  { id: "agt_p", name: "badge demo parent" },
  { id: "agt_c", name: "badge demo" },
  { id: "agt_r", name: "reviewer" },
  { id: "agt_x", name: "Über-Prüfer" },
];

describe("findMentions", () => {
  it("names agents at word edges, case-insensitively, once each, in order", () => {
    expect(findMentions("@Reviewer look, then @reviewer again", agents)).toEqual([
      "agt_r",
    ]);
    expect(findMentions("ping @reviewer and (@badge demo)", agents)).toEqual([
      "agt_r",
      "agt_c",
    ]);
  });

  it("prefers the longest name, so a name that starts like another is not split", () => {
    expect(findMentions("@badge demo parent: go", agents)).toEqual(["agt_p"]);
    expect(findMentions("@badge demo parent and @badge demo", agents)).toEqual([
      "agt_p",
      "agt_c",
    ]);
  });

  it("ignores an @ inside a word, an email, or a name it does not know", () => {
    expect(findMentions("mail me@reviewer.example", agents)).toEqual([]);
    expect(findMentions("@nobody here", agents)).toEqual([]);
    expect(findMentions("@reviewers", agents)).toEqual([]);
    expect(findMentions("no at sign", agents)).toEqual([]);
  });

  it("handles names with non-ASCII letters and punctuation", () => {
    expect(findMentions("@Über-Prüfer, hi", agents)).toEqual(["agt_x"]);
  });
});
