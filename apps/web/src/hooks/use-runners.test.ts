import { describe, expect, it } from "vitest";

import { runnerLocator } from "./use-runners";

describe("runnerLocator", () => {
  it("encodes both components", () => {
    expect(runnerLocator("a/b", "my proof#1")).toBe(
      "runner://a%2Fb/my%20proof%231"
    );
  });
});
