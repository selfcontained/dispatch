import { describe, expect, it } from "vitest";
import { parseUserAvatar } from "../src/user-avatar-settings.js";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
describe("avatar image validation", () => {
  it("accepts a small square raster image", () => {
    const avatar = { kind: "image", dataUrl: `data:image/png;base64,${png}` };
    expect(parseUserAvatar(avatar)).toEqual(avatar);
  });
  it.each([
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/png;base64,aGVsbG8=",
    `data:image/jpeg;base64,${png}`,
    "data:image/png;base64," + "A".repeat(140000),
  ])("rejects unsafe, mismatched and oversized payloads", (dataUrl) => {
    expect(parseUserAvatar({ kind: "image", dataUrl })).toBeNull();
  });
  it("rejects oversized and non-square dimensions", () => {
    for (const [width, height] of [
      [257, 257],
      [256, 128],
    ]) {
      const bytes = Buffer.from(png, "base64");
      bytes.writeUInt32BE(width!, 16);
      bytes.writeUInt32BE(height!, 20);
      expect(
        parseUserAvatar({
          kind: "image",
          dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
        })
      ).toBeNull();
    }
  });
});

it("accepts Safari canvas JPEG output with EXIF metadata", async () => {
  const { readFileSync } = await import("node:fs");
  const bytes = readFileSync(
    new URL("./fixtures-avatar-safari.jpg", import.meta.url)
  );
  const avatar = {
    kind: "image",
    dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`,
  };
  expect(parseUserAvatar(avatar)).toEqual(avatar);
});
