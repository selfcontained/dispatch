import { describe, it, expect } from "vitest";

import { shellEscape, shellQuote } from "../src/agents/tmux/quoting.js";

describe("shellEscape", () => {
  it("wraps a plain value in single quotes", () => {
    expect(shellEscape("hello")).toBe("'hello'");
  });

  it("preserves whitespace and shell metacharacters inside the quotes", () => {
    expect(shellEscape("a b $c `d` *e*")).toBe("'a b $c `d` *e*'");
  });

  it("escapes embedded single quotes via the '\\'' idiom", () => {
    expect(shellEscape("it's fine")).toBe(`'it'\\''s fine'`);
  });

  it("escapes every embedded single quote, not just the first", () => {
    expect(shellEscape("a'b'c")).toBe(`'a'\\''b'\\''c'`);
  });

  it("handles an empty string", () => {
    expect(shellEscape("")).toBe("''");
  });

  it("produces output that round-trips through bash unchanged", () => {
    // Sanity: when bash receives `'a'\''b'`, the parser concatenates
    // 'a' + \' + 'b' and the resulting argv[1] is `a'b`. We can't run bash
    // here, but the construction must follow the canonical idiom.
    expect(shellEscape("a'b")).toBe(`'a'\\''b'`);
  });
});

describe("shellQuote", () => {
  it("returns a value unchanged when there are no single quotes", () => {
    expect(shellQuote("hello world")).toBe("hello world");
  });

  it("escapes embedded single quotes for embedding inside an existing single-quoted string", () => {
    expect(shellQuote("it's fine")).toBe(`it'\\''s fine`);
  });

  it("escapes every embedded single quote", () => {
    expect(shellQuote("a'b'c")).toBe(`a'\\''b'\\''c`);
  });

  it("preserves shell metacharacters that are safe inside single quotes", () => {
    expect(shellQuote("$x `y` *.txt")).toBe("$x `y` *.txt");
  });

  it("does NOT add outer quotes (that's what shellEscape is for)", () => {
    // The two helpers solve different problems:
    //   shellEscape: I'm building a new bash arg → wrap in single quotes
    //   shellQuote:  I'm injecting into an existing single-quoted string
    // Mixing them would either over-quote or fail to escape.
    expect(shellQuote("hello").startsWith("'")).toBe(false);
    expect(shellQuote("hello").endsWith("'")).toBe(false);
  });
});
