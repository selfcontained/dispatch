import { describe, expect, it } from "vitest";

import {
  defaultFormValues,
  mergeFormValues,
  validateFormValues,
} from "./form-validation";
import type { FormField } from "./types";

describe("defaultFormValues", () => {
  it("defaults a checkbox to false when no defaultValue is set", () => {
    const fields: FormField[] = [
      { id: "agree", type: "checkbox", label: "Agree" },
    ];
    expect(defaultFormValues(fields)).toEqual({ agree: false });
  });

  it("uses a checkbox's authored defaultValue", () => {
    const fields: FormField[] = [
      { id: "agree", type: "checkbox", label: "Agree", defaultValue: true },
    ];
    expect(defaultFormValues(fields)).toEqual({ agree: true });
  });

  it("defaults a number to null when no defaultValue is set", () => {
    const fields: FormField[] = [
      { id: "count", type: "number", label: "Count" },
    ];
    expect(defaultFormValues(fields)).toEqual({ count: null });
  });

  it("uses a number's authored defaultValue", () => {
    const fields: FormField[] = [
      { id: "count", type: "number", label: "Count", defaultValue: 5 },
    ];
    expect(defaultFormValues(fields)).toEqual({ count: 5 });
  });

  it("defaults a multi-select to an empty array", () => {
    const fields: FormField[] = [
      {
        id: "tags",
        type: "select",
        label: "Tags",
        multiple: true,
        options: [{ value: "a", label: "A" }],
      },
    ];
    expect(defaultFormValues(fields)).toEqual({ tags: [] });
  });

  it("uses a multi-select's authored defaultValue array", () => {
    const fields: FormField[] = [
      {
        id: "tags",
        type: "select",
        label: "Tags",
        multiple: true,
        options: [{ value: "a", label: "A" }],
        defaultValue: ["a"],
      },
    ];
    expect(defaultFormValues(fields)).toEqual({ tags: ["a"] });
  });

  it("defaults a single-select to an empty string, not an array", () => {
    const fields: FormField[] = [
      {
        id: "size",
        type: "select",
        label: "Size",
        options: [{ value: "s", label: "Small" }],
      },
    ];
    expect(defaultFormValues(fields)).toEqual({ size: "" });
  });

  it("defaults text, textarea and radio fields to an empty string", () => {
    const fields: FormField[] = [
      { id: "name", type: "text", label: "Name" },
      { id: "notes", type: "textarea", label: "Notes" },
      {
        id: "choice",
        type: "radio",
        label: "Choice",
        options: [{ value: "x", label: "X" }],
      },
    ];
    expect(defaultFormValues(fields)).toEqual({
      name: "",
      notes: "",
      choice: "",
    });
  });

  it("uses a text field's authored defaultValue", () => {
    const fields: FormField[] = [
      { id: "name", type: "text", label: "Name", defaultValue: "Ada" },
    ];
    expect(defaultFormValues(fields)).toEqual({ name: "Ada" });
  });
});

describe("mergeFormValues", () => {
  const fields: FormField[] = [
    { id: "name", type: "text", label: "Name" },
    { id: "agree", type: "checkbox", label: "Agree" },
  ];

  it("falls back to defaults when there is no draft", () => {
    expect(mergeFormValues(fields, null)).toEqual({
      name: "",
      agree: false,
    });
  });

  it("overlays draft values onto the defaults", () => {
    expect(mergeFormValues(fields, { name: "Ada" })).toEqual({
      name: "Ada",
      agree: false,
    });
  });

  it("lets a draft override a field's authored default, not just its fallback", () => {
    const withDefaults: FormField[] = [
      { id: "name", type: "text", label: "Name", defaultValue: "Ada" },
      { id: "agree", type: "checkbox", label: "Agree", defaultValue: true },
    ];
    expect(
      mergeFormValues(withDefaults, { name: "Grace", agree: false })
    ).toEqual({ name: "Grace", agree: false });
  });

  it("does not mutate the passed-in draft", () => {
    const draft = { name: "Ada" };
    mergeFormValues(fields, draft);
    expect(draft).toEqual({ name: "Ada" });
  });
});

describe("validateFormValues", () => {
  it("returns no errors when there are no fields", () => {
    expect(validateFormValues([], {})).toEqual({});
  });

  it("flags a missing required text value", () => {
    const fields: FormField[] = [
      { id: "name", type: "text", label: "Name", required: true },
    ];
    expect(validateFormValues(fields, { name: "" })).toEqual({
      name: "Required",
    });
  });

  it("does not flag a filled required text value", () => {
    const fields: FormField[] = [
      { id: "name", type: "text", label: "Name", required: true },
    ];
    expect(validateFormValues(fields, { name: "Ada" })).toEqual({});
  });

  it("does not flag a non-required, empty value", () => {
    const fields: FormField[] = [{ id: "name", type: "text", label: "Name" }];
    expect(validateFormValues(fields, { name: "" })).toEqual({});
  });

  it("treats an unchecked required checkbox as empty", () => {
    const fields: FormField[] = [
      { id: "agree", type: "checkbox", label: "Agree", required: true },
    ];
    expect(validateFormValues(fields, { agree: false })).toEqual({
      agree: "Required",
    });
  });

  it("accepts a checked required checkbox", () => {
    const fields: FormField[] = [
      { id: "agree", type: "checkbox", label: "Agree", required: true },
    ];
    expect(validateFormValues(fields, { agree: true })).toEqual({});
  });

  it("treats an empty required multi-select array as empty", () => {
    const fields: FormField[] = [
      {
        id: "tags",
        type: "select",
        label: "Tags",
        multiple: true,
        required: true,
        options: [{ value: "a", label: "A" }],
      },
    ];
    expect(validateFormValues(fields, { tags: [] })).toEqual({
      tags: "Required",
    });
  });

  it("accepts a non-empty required multi-select array", () => {
    const fields: FormField[] = [
      {
        id: "tags",
        type: "select",
        label: "Tags",
        multiple: true,
        required: true,
        options: [{ value: "a", label: "A" }],
      },
    ];
    expect(validateFormValues(fields, { tags: ["a"] })).toEqual({});
  });

  it("rejects text shorter than minLength", () => {
    const fields: FormField[] = [
      { id: "name", type: "text", label: "Name", minLength: 3 },
    ];
    expect(validateFormValues(fields, { name: "ab" })).toEqual({
      name: "Must be at least 3 characters",
    });
  });

  it("applies the same minLength check to textarea fields", () => {
    const fields: FormField[] = [
      { id: "notes", type: "textarea", label: "Notes", minLength: 3 },
    ];
    expect(validateFormValues(fields, { notes: "ab" })).toEqual({
      notes: "Must be at least 3 characters",
    });
  });

  it("accepts text at exactly minLength", () => {
    const fields: FormField[] = [
      { id: "name", type: "text", label: "Name", minLength: 3 },
    ];
    expect(validateFormValues(fields, { name: "abc" })).toEqual({});
  });

  it("rejects text longer than maxLength", () => {
    const fields: FormField[] = [
      { id: "name", type: "text", label: "Name", maxLength: 3 },
    ];
    expect(validateFormValues(fields, { name: "abcd" })).toEqual({
      name: "Must be at most 3 characters",
    });
  });

  it("accepts text at exactly maxLength", () => {
    const fields: FormField[] = [
      { id: "name", type: "text", label: "Name", maxLength: 3 },
    ];
    expect(validateFormValues(fields, { name: "abc" })).toEqual({});
  });

  it("does not apply length checks to an empty optional value", () => {
    const fields: FormField[] = [
      { id: "name", type: "text", label: "Name", minLength: 3 },
    ];
    expect(validateFormValues(fields, { name: "" })).toEqual({});
  });

  it("rejects a number below min", () => {
    const fields: FormField[] = [
      { id: "count", type: "number", label: "Count", min: 5 },
    ];
    expect(validateFormValues(fields, { count: 4 })).toEqual({
      count: "Must be at least 5",
    });
  });

  it("accepts a number at exactly min", () => {
    const fields: FormField[] = [
      { id: "count", type: "number", label: "Count", min: 5 },
    ];
    expect(validateFormValues(fields, { count: 5 })).toEqual({});
  });

  it("rejects a number above max", () => {
    const fields: FormField[] = [
      { id: "count", type: "number", label: "Count", min: 0, max: 10 },
    ];
    expect(validateFormValues(fields, { count: 11 })).toEqual({
      count: "Must be at most 10",
    });
  });

  it("accepts a number at exactly max", () => {
    const fields: FormField[] = [
      { id: "count", type: "number", label: "Count", max: 10 },
    ];
    expect(validateFormValues(fields, { count: 10 })).toEqual({});
  });

  it("does not apply number range checks to a null value", () => {
    const fields: FormField[] = [
      { id: "count", type: "number", label: "Count", min: 5 },
    ];
    expect(validateFormValues(fields, { count: null })).toEqual({});
  });

  it("validates independent fields independently", () => {
    const fields: FormField[] = [
      { id: "name", type: "text", label: "Name", required: true },
      { id: "count", type: "number", label: "Count", min: 5 },
    ];
    expect(validateFormValues(fields, { name: "Ada", count: 1 })).toEqual({
      count: "Must be at least 5",
    });
  });
});
