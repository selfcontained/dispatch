import { describe, expect, it } from "vitest";

import { splitPinValues } from "../../web/src/lib/pins.ts";

describe("splitPinValues", () => {
  it("splits filename pins on commas and newlines", () => {
    expect(splitPinValues("filename", "one.ts,\ntwo.ts\nthree.ts")).toEqual([
      "one.ts",
      "two.ts",
      "three.ts",
    ]);
  });

  it("splits port pins on commas and whitespace", () => {
    expect(splitPinValues("port", "3000 4000,\n5000")).toEqual([
      "3000",
      "4000",
      "5000",
    ]);
  });

  it("does not split string pins", () => {
    expect(splitPinValues("string", "line 1\n\n  line 2")).toEqual([
      "line 1\n\n  line 2",
    ]);
  });

  it("does not split code pins", () => {
    expect(splitPinValues("code", "DISPATCH_AGENT_ID=agt_123")).toEqual([
      "DISPATCH_AGENT_ID=agt_123",
    ]);
  });

  it("does not split pr pins", () => {
    expect(splitPinValues("pr", "Review queue")).toEqual([
      "Review queue",
    ]);
  });

  it("does not split url pins", () => {
    expect(splitPinValues("url", "http://127.0.0.1:59470/api/v1/agents?view=full&tab=pins")).toEqual([
      "http://127.0.0.1:59470/api/v1/agents?view=full&tab=pins",
    ]);
  });

  it("does not split markdown pins", () => {
    expect(splitPinValues("markdown", "**Status**\n- Ready\n- Branch: `feat/log-rotation`")).toEqual([
      "**Status**\n- Ready\n- Branch: `feat/log-rotation`",
    ]);
  });

  it("preserves the original value when split delimiters produce no tokens", () => {
    expect(splitPinValues("filename", ",\n")).toEqual([",\n"]);
    expect(splitPinValues("port", " , \n ")).toEqual([" , \n "]);
  });
});
