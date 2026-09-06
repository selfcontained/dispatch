import { describe, expect, it } from "vitest";

import {
  dimensionFields,
  mediaMetadataFromBuffer,
  parseMediaMetadata,
} from "../src/media/metadata.js";

/** A real 37x19 PNG, so the buffer path is exercised on encoder output. */
const PNG_37x19 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACUAAAATCAIAAACY31PkAAAACXBIWXMAAAPoAAAD6AG1" +
    "e1JrAAAALElEQVR4nGM4EaBBT8Qwal/AaHieGE0vGqP54cRo+aIxWn4GjNYPGsOnvgUA" +
    "48pu7rw5XfcAAAAASUVORK5CYII=",
  "base64"
);

describe("parseMediaMetadata", () => {
  it("reads a well-formed pair", () => {
    expect(parseMediaMetadata({ width: 120, height: 90 })).toEqual({
      width: 120,
      height: 90,
    });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a scalar", 7],
    ["a string", "120x90"],
    ["an array", [120, 90]],
  ])("returns an empty bag for %s", (_label, value) => {
    expect(parseMediaMetadata(value)).toEqual({});
  });

  it("reads an empty object as an empty bag", () => {
    // What every row written before this column existed holds.
    expect(parseMediaMetadata({})).toEqual({});
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 12.5],
    ["absurd", 4_000_000_000],
    ["a string", "120"],
  ])("refuses a %s width, and takes the height with it", (_label, width) => {
    // Half a pair is not a ratio, so there is nothing to salvage — the row
    // falls back to the fixed box rather than reserving a nonsense one.
    expect(parseMediaMetadata({ width, height: 90 })).toEqual({});
  });

  it("keeps keys it has not been taught about", () => {
    // A writer recording something this module does not know about — a video's
    // duration, say — must not lose it on a round-trip through here.
    expect(
      parseMediaMetadata({ width: 120, height: 90, duration: 4.5 })
    ).toEqual({ width: 120, height: 90, duration: 4.5 });
  });

  it("does not invent a dimension from a misspelled key", () => {
    // The whole reason reads go through here: in raw jsonb this typo is
    // invisible, and the feed silently falls back to a fixed box forever.
    const parsed = parseMediaMetadata({ widht: 120, height: 90 });
    expect(parsed.width).toBeUndefined();
    expect(dimensionFields(parsed)).toEqual({});
  });
});

describe("dimensionFields", () => {
  it("emits both or neither", () => {
    expect(dimensionFields({ width: 120, height: 90 })).toEqual({
      width: 120,
      height: 90,
    });
    expect(dimensionFields({ width: 120 })).toEqual({});
    expect(dimensionFields({ height: 90 })).toEqual({});
    expect(dimensionFields({})).toEqual({});
  });
});

describe("mediaMetadataFromBuffer", () => {
  it("measures an image", () => {
    expect(mediaMetadataFromBuffer(PNG_37x19)).toEqual({
      width: 37,
      height: 19,
    });
  });

  it.each([
    ["a PDF", Buffer.from("%PDF-1.7\n%abcd")],
    ["plain text", Buffer.from("# notes\n")],
    ["nothing at all", Buffer.alloc(0)],
    ["a truncated image", PNG_37x19.subarray(0, 20)],
  ])("returns an empty bag for %s", (_label, buffer) => {
    expect(mediaMetadataFromBuffer(buffer)).toEqual({});
  });
});
