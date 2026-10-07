// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { prepareAvatarPhoto, AVATAR_SOURCE_MAX_BYTES } from "./prepare-avatar";

afterEach(() => vi.restoreAllMocks());

it("rejects oversized inputs before trying to decode them", async () => {
  const file = new File(["x"], "large.jpg", { type: "image/jpeg" });
  Object.defineProperty(file, "size", { value: AVATAR_SOURCE_MAX_BYTES + 1 });
  await expect(prepareAvatarPhoto(file)).rejects.toThrow("50 MB");
});

it("rejects unsupported formats even with misleading names", async () => {
  await expect(
    prepareAvatarPhoto(
      new File(["<svg/>"], "photo.jpg", { type: "image/svg+xml" })
    )
  ).rejects.toThrow("Choose a PNG");
});
