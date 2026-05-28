import { describe, expect, it } from "vitest";

import {
  acceptGhostCompletion,
  filterHistoryOptions,
  getHistoryOptions,
  ghostCompletionSuffix,
} from "./path-input-utils";

describe("path input completion", () => {
  it("accepts a directory completion without appending a trailing slash", () => {
    const suffix = ghostCompletionSuffix("~/dev/apps", "~/dev/apps/dispatch");

    expect(acceptGhostCompletion("~/dev/apps", suffix)).toBe(
      "~/dev/apps/dispatch"
    );
  });

  it("does not duplicate a slash when completing inside a typed directory", () => {
    const suffix = ghostCompletionSuffix("~/dev/apps/", "~/dev/apps/dispatch");

    expect(acceptGhostCompletion("~/dev/apps/", suffix)).toBe(
      "~/dev/apps/dispatch"
    );
  });
});

describe("path input history", () => {
  it("sorts frequently used projects before recent entries", () => {
    const options = getHistoryOptions(
      ["~/work/customer-portal", "~/dev/apps/dispatch", "~/dev/tools/codex"],
      {
        "~/work/customer-portal": { usageCount: 7 },
        "~/dev/apps/dispatch": { usageCount: 32, label: "dispatch" },
        "~/dev/tools/codex": { usageCount: 18 },
      }
    );

    expect(options.map((option) => option.path)).toEqual([
      "~/dev/apps/dispatch",
      "~/dev/tools/codex",
      "~/work/customer-portal",
    ]);
    expect(options[0].label).toBe("dispatch");
  });

  it("falls back to recent order when usage counts match", () => {
    const options = getHistoryOptions(["~/a", "~/b"], {});

    expect(options.map((option) => option.path)).toEqual(["~/a", "~/b"]);
  });

  it("filters by compact project label", () => {
    const options = getHistoryOptions(
      ["~/dev/apps/dispatch", "~/tools/codex"],
      {
        "~/dev/apps/dispatch": { label: "dispatch", usageCount: 4 },
        "~/tools/codex": { label: "codex", usageCount: 9 },
      }
    );

    expect(
      filterHistoryOptions(options, "dispatch").map((option) => option.path)
    ).toEqual(["~/dev/apps/dispatch"]);
  });

  it("filters by full path prefix or segment", () => {
    const options = getHistoryOptions(
      ["~/dev/apps/dispatch", "~/work/customer-portal"],
      {}
    );

    expect(
      filterHistoryOptions(options, "~/dev/apps").map((option) => option.path)
    ).toEqual(["~/dev/apps/dispatch"]);
    expect(
      filterHistoryOptions(options, "customer").map((option) => option.path)
    ).toEqual(["~/work/customer-portal"]);
  });
});
