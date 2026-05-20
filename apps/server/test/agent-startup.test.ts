import { describe, it, expect } from "vitest";

import {
  parseOptionalBooleanField,
  parseOptionalStringArrayField,
  createStartupPins,
  parseCreateAgentRequest,
  MAX_STARTUP_FILE_COUNT,
} from "../src/routes/agent-startup.js";

describe("parseOptionalBooleanField", () => {
  it("returns undefined for undefined input", () => {
    expect(parseOptionalBooleanField(undefined, "f", false)).toBeUndefined();
  });

  it("passes through boolean values", () => {
    expect(parseOptionalBooleanField(true, "f", false)).toBe(true);
    expect(parseOptionalBooleanField(false, "f", false)).toBe(false);
  });

  it("coerces string booleans when allowed", () => {
    expect(parseOptionalBooleanField("true", "f", true)).toBe(true);
    expect(parseOptionalBooleanField("false", "f", true)).toBe(false);
  });

  it("rejects string booleans when coercion is disabled", () => {
    expect(() => parseOptionalBooleanField("true", "myField", false)).toThrow(
      "myField must be a boolean"
    );
  });

  it("rejects non-boolean types", () => {
    expect(() => parseOptionalBooleanField(42, "field", true)).toThrow(
      "field must be a boolean"
    );
    expect(() => parseOptionalBooleanField("yes", "field", true)).toThrow(
      "field must be a boolean"
    );
  });
});

describe("parseOptionalStringArrayField", () => {
  it("returns undefined for undefined input", () => {
    expect(
      parseOptionalStringArrayField(undefined, "f", false)
    ).toBeUndefined();
  });

  it("passes through string arrays", () => {
    expect(parseOptionalStringArrayField(["a", "b"], "f", false)).toEqual([
      "a",
      "b",
    ]);
  });

  it("parses JSON string when coercion is allowed", () => {
    expect(parseOptionalStringArrayField('["x","y"]', "f", true)).toEqual([
      "x",
      "y",
    ]);
  });

  it("rejects non-string-array JSON", () => {
    expect(() => parseOptionalStringArrayField("[1,2]", "f", true)).toThrow(
      "must be an array of strings"
    );
  });

  it("rejects plain string when coercion is disabled", () => {
    expect(() => parseOptionalStringArrayField("hello", "f", false)).toThrow(
      "must be an array of strings"
    );
  });

  it("rejects mixed arrays", () => {
    expect(() => parseOptionalStringArrayField(["a", 1], "f", false)).toThrow(
      "must be an array of strings"
    );
  });
});

describe("createStartupPins", () => {
  it("creates pins from URLs with hostname labels", () => {
    const pins = createStartupPins(["https://github.com/foo/bar"]);
    expect(pins).toEqual([
      { label: "github.com", value: "https://github.com/foo/bar", type: "url" },
    ]);
  });

  it("strips www. from hostnames", () => {
    const pins = createStartupPins(["https://www.example.com/page"]);
    expect(pins[0].label).toBe("example.com");
  });

  it("numbers duplicate hostnames", () => {
    const pins = createStartupPins([
      "https://github.com/a",
      "https://github.com/b",
      "https://github.com/c",
    ]);
    expect(pins.map((p) => p.label)).toEqual([
      "github.com",
      "github.com 2",
      "github.com 3",
    ]);
  });

  it("handles mixed hostnames", () => {
    const pins = createStartupPins([
      "https://github.com/a",
      "https://linear.app/b",
      "https://github.com/c",
    ]);
    expect(pins.map((p) => p.label)).toEqual([
      "github.com",
      "linear.app",
      "github.com 2",
    ]);
  });

  it("returns empty array for no URLs", () => {
    expect(createStartupPins([])).toEqual([]);
  });
});

describe("parseCreateAgentRequest", () => {
  it("handles non-multipart request", async () => {
    const result = await parseCreateAgentRequest({
      body: { name: "test" },
      isMultipart: () => false,
      parts: async function* () {},
    });
    expect(result.body).toEqual({ name: "test" });
    expect(result.startupFiles).toEqual([]);
    expect(result.isMultipart).toBe(false);
  });

  it("handles non-multipart request with no body", async () => {
    const result = await parseCreateAgentRequest({
      body: undefined,
      isMultipart: () => false,
      parts: async function* () {},
    });
    expect(result.body).toEqual({});
  });

  it("parses multipart fields and files", async () => {
    const result = await parseCreateAgentRequest({
      body: undefined,
      isMultipart: () => true,
      parts: async function* () {
        yield { type: "field", fieldname: "name", value: "my-agent" };
        yield {
          type: "file",
          fieldname: "startupFiles",
          filename: "notes.md",
          toBuffer: async () => Buffer.from("# Notes"),
        };
      },
    });
    expect(result.isMultipart).toBe(true);
    expect(result.body.name).toBe("my-agent");
    expect(result.startupFiles).toHaveLength(1);
    expect(result.startupFiles[0].fileName).toBe("notes.md");
    expect(result.startupFiles[0].source).toBe("text");
  });

  it("classifies image files as user source", async () => {
    const result = await parseCreateAgentRequest({
      body: undefined,
      isMultipart: () => true,
      parts: async function* () {
        yield {
          type: "file",
          fieldname: "startupFiles",
          filename: "screenshot.png",
          toBuffer: async () => Buffer.from("fake-png"),
        };
      },
    });
    expect(result.startupFiles[0].source).toBe("user");
  });

  it("rejects unexpected file fields", async () => {
    await expect(
      parseCreateAgentRequest({
        body: undefined,
        isMultipart: () => true,
        parts: async function* () {
          yield {
            type: "file",
            fieldname: "avatar",
            filename: "pic.png",
            toBuffer: async () => Buffer.from(""),
          };
        },
      })
    ).rejects.toThrow("Unexpected file field");
  });

  it("rejects unsupported file types", async () => {
    await expect(
      parseCreateAgentRequest({
        body: undefined,
        isMultipart: () => true,
        parts: async function* () {
          yield {
            type: "file",
            fieldname: "startupFiles",
            filename: "script.exe",
            toBuffer: async () => Buffer.from(""),
          };
        },
      })
    ).rejects.toThrow("Unsupported file type");
  });

  it("enforces maximum file count", async () => {
    await expect(
      parseCreateAgentRequest({
        body: undefined,
        isMultipart: () => true,
        parts: async function* () {
          for (let i = 0; i <= MAX_STARTUP_FILE_COUNT; i++) {
            yield {
              type: "file",
              fieldname: "startupFiles",
              filename: `file${i}.txt`,
              toBuffer: async () => Buffer.from("content"),
            };
          }
        },
      })
    ).rejects.toThrow(`A maximum of ${MAX_STARTUP_FILE_COUNT}`);
  });
});
