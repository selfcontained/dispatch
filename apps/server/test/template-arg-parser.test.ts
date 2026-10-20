import { describe, expect, it } from "vitest";

import {
  parseTemplateArgs,
  substituteArgs,
  TEMPLATE_ARG_PATTERN,
} from "../src/templates/arg-parser.js";

describe("TEMPLATE_ARG_PATTERN", () => {
  it("matches {{D:...}} placeholders", () => {
    const matches = [
      ..."Hello {{D:name}} world {{D:age}}".matchAll(
        new RegExp(TEMPLATE_ARG_PATTERN.source, "g")
      ),
    ];
    expect(matches).toHaveLength(2);
    expect(matches[0][1]).toBe("name");
    expect(matches[1][1]).toBe("age");
  });

  it("does not match plain {{...}} without D: prefix", () => {
    const matches = [
      ..."Hello {{name}}".matchAll(
        new RegExp(TEMPLATE_ARG_PATTERN.source, "g")
      ),
    ];
    expect(matches).toHaveLength(0);
  });
});

describe("parseTemplateArgs", () => {
  it("returns empty array for prompt with no placeholders", () => {
    expect(parseTemplateArgs("Hello world")).toEqual([]);
  });

  it("parses a single arg with no modifiers", () => {
    const result = parseTemplateArgs("Fix {{D:repo_url}} please");
    expect(result).toEqual([
      {
        name: "repo_url",
        key: "repo_url",
        placeholder: "{{D:repo_url}}",
        required: false,
        multiline: false,
      },
    ]);
  });

  it("parses the required modifier", () => {
    const result = parseTemplateArgs("Deploy {{D:target|required}}");
    expect(result).toHaveLength(1);
    expect(result[0].required).toBe(true);
    expect(result[0].multiline).toBe(false);
  });

  it("parses the multiline modifier", () => {
    const result = parseTemplateArgs("Context: {{D:description|multiline}}");
    expect(result).toHaveLength(1);
    expect(result[0].multiline).toBe(true);
  });

  it("parses the textarea modifier as multiline", () => {
    const result = parseTemplateArgs("Context: {{D:description|textarea}}");
    expect(result).toHaveLength(1);
    expect(result[0].multiline).toBe(true);
  });

  it("parses multiple modifiers together", () => {
    const result = parseTemplateArgs("Input: {{D:context|required|multiline}}");
    expect(result).toHaveLength(1);
    expect(result[0].required).toBe(true);
    expect(result[0].multiline).toBe(true);
  });

  it("is case-insensitive for modifiers", () => {
    const result = parseTemplateArgs("{{D:foo|Required|MULTILINE}}");
    expect(result[0].required).toBe(true);
    expect(result[0].multiline).toBe(true);
  });

  it("parses multiple distinct args", () => {
    const result = parseTemplateArgs(
      "Deploy {{D:service}} to {{D:environment|required}}"
    );
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("service");
    expect(result[1].name).toBe("environment");
    expect(result[1].required).toBe(true);
  });

  it("deduplicates args by key (case-insensitive)", () => {
    const result = parseTemplateArgs("First: {{D:Name}}, second: {{D:name}}");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Name");
    expect(result[0].key).toBe("name");
  });

  it("merges modifiers across duplicates — required wins if either has it", () => {
    const result = parseTemplateArgs("{{D:input}} then {{D:input|required}}");
    expect(result).toHaveLength(1);
    expect(result[0].required).toBe(true);
  });

  it("merges modifiers across duplicates — multiline wins if either has it", () => {
    const result = parseTemplateArgs("{{D:notes|multiline}} then {{D:notes}}");
    expect(result).toHaveLength(1);
    expect(result[0].multiline).toBe(true);
  });

  it("keeps the first placeholder for duplicates", () => {
    const result = parseTemplateArgs("{{D:x|required}} and {{D:x|multiline}}");
    expect(result).toHaveLength(1);
    expect(result[0].placeholder).toBe("{{D:x|required}}");
    expect(result[0].required).toBe(true);
    expect(result[0].multiline).toBe(true);
  });

  it("skips arg specs that are empty after trimming", () => {
    const result = parseTemplateArgs("{{D: }} normal {{D:name}}");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("name");
  });

  it("does not match {{D:}} (no content between delimiters)", () => {
    const result = parseTemplateArgs("{{D:}} normal {{D:name}}");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("name");
  });

  it("trims whitespace in arg names", () => {
    const result = parseTemplateArgs("{{D: spaced }}");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("spaced");
    expect(result[0].key).toBe("spaced");
  });
});

describe("substituteArgs", () => {
  it("replaces placeholders with provided values", () => {
    const result = substituteArgs("Deploy {{D:service}} to {{D:env}}", {
      service: "api",
      env: "prod",
    });
    expect(result).toBe("Deploy api to prod");
  });

  it("replaces by key (lowercase match)", () => {
    const result = substituteArgs("Hello {{D:Name}}", { name: "world" });
    expect(result).toBe("Hello world");
  });

  it("replaces by original name when key doesn't match", () => {
    const result = substituteArgs("Hello {{D:Name}}", { Name: "world" });
    expect(result).toBe("Hello world");
  });

  it("replaces missing optional args with empty string", () => {
    const result = substituteArgs("Hello {{D:name}} {{D:suffix}}", {
      name: "world",
    });
    expect(result).toBe("Hello world ");
  });

  it("throws when a required arg is missing", () => {
    expect(() => substituteArgs("Deploy {{D:target|required}}", {})).toThrow(
      "Missing required template arguments: target"
    );
  });

  it("throws listing all missing required args", () => {
    expect(() =>
      substituteArgs("{{D:a|required}} {{D:b|required}} {{D:c}}", {})
    ).toThrow("Missing required template arguments: a, b");
  });

  it("does not throw when required arg is provided", () => {
    const result = substituteArgs("Deploy {{D:target|required}}", {
      target: "prod",
    });
    expect(result).toBe("Deploy prod");
  });

  it("handles multiple occurrences of the same placeholder", () => {
    const result = substituteArgs("{{D:x}} and {{D:x}} again", { x: "val" });
    expect(result).toBe("val and val again");
  });

  it("handles prompt with no placeholders", () => {
    const result = substituteArgs("No args here", {});
    expect(result).toBe("No args here");
  });

  it("replaces whitespace-only arg specs with empty string", () => {
    const result = substituteArgs("Before {{D: }} after", {});
    expect(result).toBe("Before  after");
  });

  it("leaves {{D:}} untouched (regex requires content)", () => {
    const result = substituteArgs("Before {{D:}} after", {});
    expect(result).toBe("Before {{D:}} after");
  });
});

describe("defaults and options", () => {
  function permutations(values: string[]): string[][] {
    return values.length === 0
      ? [[]]
      : values.flatMap((value, i) =>
          permutations(values.filter((_, j) => j !== i)).map((rest) => [
            value,
            ...rest,
          ])
        );
  }
  it.each(
    permutations([
      "DeFaUlT= Staging West ",
      "OPTIONS= dev, Staging West ",
      "REQUIRED",
      "multiline",
    ])
  )("ignores modifier order: %j", (...modifiers) => {
    const prompt = `{{D:Environment|${modifiers.join("|")}}}`;
    expect(parseTemplateArgs(prompt)[0]).toMatchObject({
      default: "Staging West",
      options: ["dev", "Staging West"],
      required: true,
      multiline: true,
    });
    expect(substituteArgs(prompt, {})).toBe("Staging West");
    expect(() => substituteArgs(prompt, { environment: "production" })).toThrow(
      "choose one of dev, Staging West"
    );
    expect(() => substituteArgs(prompt, { environment: "" })).toThrow(
      "Missing required"
    );
  });
  it("uses defaults only for omitted values, including repeated case variants", () => {
    const prompt = "{{D:Branch}}/{{D:branch|default=main}}";
    expect(substituteArgs(prompt, {})).toBe("main/main");
    expect(substituteArgs(prompt, { Branch: "topic" })).toBe("topic/topic");
    expect(substituteArgs(prompt, { branch: "" })).toBe("/");
  });
  it("merges declarations before validating defaults", () => {
    const prompt =
      "{{D:Env|default=staging}} {{D:env|options=dev,staging|required|multiline}}";
    expect(substituteArgs(prompt, {})).toBe("staging staging");
    expect(parseTemplateArgs(prompt)[0]).toMatchObject({
      required: true,
      multiline: true,
    });
  });
  it.each([
    ["{{D:X|default=a}} {{D:x|default=b}}", "Conflicting default"],
    ["{{D:X|options=a,b}} {{D:x|options=b,a}}", "Conflicting options"],
    ["{{D:X|default=a|default=b}}", "Conflicting default"],
    ["{{D:X|default=c|options=a,b}}", "Invalid default"],
    ["{{D:X|options=a,,b}}", "choices must be nonempty"],
    ["{{D:X|default= |required}}", "nonblank"],
  ])("rejects invalid configuration %s", (prompt, message) => {
    expect(parseTemplateArgs(prompt)[0].error).toContain(message);
    expect(() => substituteArgs(prompt, {})).toThrow(message);
  });
  it("accepts identical explicit declarations and rejects whitespace required values", () => {
    expect(
      substituteArgs(
        "{{D:X|options=a,b|default=a}} {{D:x|default=a|options=a,b}}",
        {}
      )
    ).toBe("a a");
    expect(() =>
      substituteArgs("{{D:X|required|default=a}}", { x: "  " })
    ).toThrow("Missing required");
  });
  it("escapes delimiters without consuming ordinary backslashes", () => {
    const prompt = String.raw`{{D:Label|options=one\,two,a\|b,brace\},C:\temp\\|default=brace\}}}`;
    expect(parseTemplateArgs(prompt)[0]).toMatchObject({
      options: ["one,two", "a|b", "brace}", "C:\\temp\\"],
      default: "brace}",
    });
    expect(substituteArgs(prompt, {})).toBe("brace}");
    expect(
      substituteArgs(String.raw`{{D:Path|default=C:\work\repo}}`, {})
    ).toBe(String.raw`C:\work\repo`);
  });
  it("leaves incomplete escaped declarations editable", () => {
    expect(parseTemplateArgs("{{D:X|default=" + "\\".repeat(500))).toEqual([]);
  });
  it("does not read inherited values", () => {
    expect(substituteArgs("{{D:toString|default=ok}}", {})).toBe("ok");
  });
});
