import { describe, expect, it } from "vitest";

import {
  acceptGhostCompletion,
  filterHistoryOptions,
  getHistoryOptions,
  ghostCompletionSuffix,
  mergeHistoryOptions,
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

describe("path input option merging", () => {
  it("fills in a missing iconUrl from the secondary source instead of dropping it", () => {
    const primary = getHistoryOptions(["~/dev/apps/dispatch"], {
      "~/dev/apps/dispatch": { usageCount: 3 },
    });
    const secondary = getHistoryOptions(["~/dev/apps/dispatch"], {
      "~/dev/apps/dispatch": {
        usageCount: 3,
        iconUrl: "/api/v1/agents/agt_1/repo-icon",
      },
    });

    const merged = mergeHistoryOptions(primary, secondary);

    expect(merged).toHaveLength(1);
    expect(merged[0].iconUrl).toBe("/api/v1/agents/agt_1/repo-icon");
  });

  it("keeps the primary source's iconUrl when both sides have one", () => {
    const primary = getHistoryOptions(["~/dev/apps/dispatch"], {
      "~/dev/apps/dispatch": { usageCount: 3, iconUrl: "/primary-icon" },
    });
    const secondary = getHistoryOptions(["~/dev/apps/dispatch"], {
      "~/dev/apps/dispatch": { usageCount: 3, iconUrl: "/secondary-icon" },
    });

    expect(mergeHistoryOptions(primary, secondary)[0].iconUrl).toBe(
      "/primary-icon"
    );
  });

  it("takes the higher usage count across sources", () => {
    const primary = getHistoryOptions(["~/dev/apps/dispatch"], {
      "~/dev/apps/dispatch": { usageCount: 2 },
    });
    const secondary = getHistoryOptions(["~/dev/apps/dispatch"], {
      "~/dev/apps/dispatch": { usageCount: 9 },
    });

    expect(mergeHistoryOptions(primary, secondary)[0].usageCount).toBe(9);
  });

  it("keeps entries unique to either source", () => {
    const primary = getHistoryOptions(["~/a"], {});
    const secondary = getHistoryOptions(["~/b"], {});

    expect(
      mergeHistoryOptions(primary, secondary).map((option) => option.path)
    ).toEqual(["~/a", "~/b"]);
  });
});
