import { expect, expectTypeOf, it } from "vitest";
import { DIFF_IMAGE_MAX_BYTES, type DiffImageInfo } from "@dispatch/shared";
import {
  DIFF_IMAGE_MAX_BYTES as runnerLimit,
  type DiffImageInfo as RunnerImageInfo,
} from "@dispatch/runner-protocol/diff-types";

it("preserves the shared image byte limit and exact optional revision shape", () => {
  expect(DIFF_IMAGE_MAX_BYTES).toBe(10 * 1024 * 1024);
  expect(DIFF_IMAGE_MAX_BYTES).toBe(runnerLimit);
  expectTypeOf<DiffImageInfo>().toEqualTypeOf<RunnerImageInfo>();
  expectTypeOf<DiffImageInfo>().toEqualTypeOf<{
    revision?: string;
    oldSize: number | null;
    newSize: number | null;
  }>();
});
