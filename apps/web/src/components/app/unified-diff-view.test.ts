// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { parseDiff } from "react-diff-view";
import { refractor } from "refractor";
import javascript from "refractor/javascript";

import { tokenizeHunksIndependently } from "./unified-diff-view";

refractor.register(javascript);

const refractorAdapter = {
  highlight(code: string, language: string) {
    return refractor.highlight(code, language).children;
  },
  registered(language: string) {
    return refractor.registered(language);
  },
};

function hasTokenClass(tokens: unknown, className: string): boolean {
  return JSON.stringify(tokens).includes(`"${className}"`);
}

describe("tokenizeHunksIndependently", () => {
  it("does not leak an unterminated construct into a later hunk", () => {
    const diff = `diff --git a/example.js b/example.js
--- a/example.js
+++ b/example.js
@@ -1,2 +1,2 @@
-/* removed comment start
+const first = true;
 console.log(first);
@@ -20,2 +20,2 @@
-const oldValue = 1;
+const value = 2;
 console.log(value);
`;
    const file = parseDiff(diff)[0]!;

    const tokens = tokenizeHunksIndependently(file.hunks, {
      highlight: true,
      refractor: refractorAdapter,
      language: "javascript",
    });

    // Processing the later hunk must not replace this first-hunk token with
    // the empty placeholder emitted for omitted lines before that hunk.
    expect(hasTokenClass(tokens.new[0], "keyword")).toBe(true);

    // The new-side line is line 20. It must retain its JavaScript keyword
    // token instead of inheriting the earlier unterminated block comment.
    expect(hasTokenClass(tokens.new[19], "keyword")).toBe(true);
    expect(hasTokenClass(tokens.new[19], "comment")).toBe(false);
  });
});
