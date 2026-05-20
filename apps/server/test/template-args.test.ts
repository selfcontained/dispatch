import { describe, it, expect } from "vitest";

import { parseTemplateArgs, substituteArgs } from "../src/templates/store.js";

describe("parseTemplateArgs", () => {
  it("extracts a single argument", () => {
    const args = parseTemplateArgs("Hello {{D:Name}}!");
    expect(args).toEqual([
      { name: "Name", key: "name", placeholder: "{{D:Name}}" },
    ]);
  });

  it("extracts multiple distinct arguments", () => {
    const args = parseTemplateArgs("{{D:Repo}} on {{D:Branch}}");
    expect(args).toHaveLength(2);
    expect(args[0].name).toBe("Repo");
    expect(args[1].name).toBe("Branch");
  });

  it("deduplicates case-insensitively", () => {
    const args = parseTemplateArgs("{{D:Name}} and {{D:name}} and {{D:NAME}}");
    expect(args).toHaveLength(1);
    expect(args[0].name).toBe("Name");
  });

  it("trims whitespace from argument names", () => {
    const args = parseTemplateArgs("{{D:  Spaced  }}");
    expect(args).toEqual([
      { name: "Spaced", key: "spaced", placeholder: "{{D:  Spaced  }}" },
    ]);
  });

  it("returns empty array when no arguments present", () => {
    expect(parseTemplateArgs("no args here")).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseTemplateArgs("")).toEqual([]);
  });

  it("ignores incomplete patterns", () => {
    expect(parseTemplateArgs("{{D:Unclosed")).toEqual([]);
    expect(parseTemplateArgs("{{D:}}")).toEqual([]);
  });

  it("handles adjacent arguments", () => {
    const args = parseTemplateArgs("{{D:A}}{{D:B}}");
    expect(args).toHaveLength(2);
    expect(args[0].name).toBe("A");
    expect(args[1].name).toBe("B");
  });
});

describe("substituteArgs", () => {
  it("replaces a single argument", () => {
    expect(substituteArgs("Hello {{D:Name}}!", { name: "World" })).toBe(
      "Hello World!"
    );
  });

  it("replaces multiple arguments", () => {
    expect(
      substituteArgs("{{D:Repo}} on {{D:Branch}}", {
        repo: "dispatch",
        branch: "main",
      })
    ).toBe("dispatch on main");
  });

  it("matches args by lowercased key first, then original name", () => {
    expect(substituteArgs("{{D:Name}}", { name: "lower" })).toBe("lower");
    expect(substituteArgs("{{D:Name}}", { Name: "original" })).toBe("original");
  });

  it("throws when required argument is missing", () => {
    expect(() => substituteArgs("{{D:Missing}}", {})).toThrow(
      "Missing required template arguments: Missing"
    );
  });

  it("lists all missing arguments in the error", () => {
    expect(() => substituteArgs("{{D:A}} {{D:B}}", {})).toThrow(
      "Missing required template arguments: A, B"
    );
  });

  it("replaces deduplicated arguments consistently", () => {
    expect(substituteArgs("{{D:X}} and {{D:x}}", { x: "val" })).toBe(
      "val and val"
    );
  });

  it("returns prompt unchanged when there are no placeholders", () => {
    expect(substituteArgs("plain text", {})).toBe("plain text");
  });

  it("handles empty replacement value", () => {
    expect(substituteArgs("before{{D:Gap}}after", { gap: "" })).toBe(
      "beforeafter"
    );
  });
});
