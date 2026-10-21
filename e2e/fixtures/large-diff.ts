import type { DiffResponse } from "../../packages/shared/src/diff-types";

/** 87k changed lines in existing files: three replacement hunks and unchanged gaps. */
export function largeDiffFixture(): DiffResponse {
  return {
    baseRef: "fixture",
    files: Array.from({ length: 145 }, (_, index) => {
      const path = `src/large/file-${String(index).padStart(3, "0")}.ts`;
      const hunks = [100, 500, 1000].map((start) => {
        const context = (line: number) =>
          ` export const value${line} = { enabled: true, count: ${line} };`;
        return [
          `@@ -${start - 2},106 +${start - 2},106 @@`,
          ...Array.from({ length: 3 }, (_, offset) =>
            context(start - 3 + offset)
          ),
          ...Array.from(
            { length: 100 },
            (_, offset) =>
              `-export const value${start + offset} = { enabled: true, count: ${start + offset} };`
          ),
          ...Array.from(
            { length: 100 },
            (_, offset) =>
              `+export const value${start + offset} = { enabled: false, count: ${start + offset + 1} };`
          ),
          ...Array.from({ length: 3 }, (_, offset) =>
            context(start + 100 + offset)
          ),
        ].join("\n");
      });
      return {
        path,
        status: "modified",
        added: 300,
        deleted: 300,
        truncated: false,
        isTest: false,
        diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks.join("\n")}\n`,
      };
    }),
  };
}
