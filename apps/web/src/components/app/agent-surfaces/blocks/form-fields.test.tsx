// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FormField } from "@/components/app/agent-surfaces/types";
import { FormFieldControl } from "./form-fields";

afterEach(() => {
  cleanup();
});

describe("FormFieldControl per-type rendering", () => {
  it("renders a text field as a single-line input", () => {
    const onChange = vi.fn();
    render(
      <FormFieldControl
        field={{ id: "name", type: "text", label: "Name" }}
        fieldId="name"
        value="Ada"
        onChange={onChange}
      />
    );
    const input = screen.getByLabelText("Name") as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    fireEvent.change(input, { target: { value: "Grace" } });
    expect(onChange).toHaveBeenCalledWith("Grace");
  });

  it("renders a textarea field as a multi-line control", () => {
    render(
      <FormFieldControl
        field={{ id: "notes", type: "textarea", label: "Notes" }}
        fieldId="notes"
        value={undefined}
        onChange={() => {}}
      />
    );
    expect(screen.getByLabelText("Notes").tagName).toBe("TEXTAREA");
  });

  it("renders a number field and coerces empty input to null", () => {
    const onChange = vi.fn();
    render(
      <FormFieldControl
        field={{ id: "count", type: "number", label: "Count" }}
        fieldId="count"
        value={3}
        onChange={onChange}
      />
    );
    const input = screen.getByLabelText("Count") as HTMLInputElement;
    expect(input.type).toBe("number");
    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("renders a checkbox field", () => {
    const onChange = vi.fn();
    render(
      <FormFieldControl
        field={{ id: "agree", type: "checkbox", label: "I agree" }}
        fieldId="agree"
        value={false}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "I agree" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("renders a single-select field as a combobox", () => {
    render(
      <FormFieldControl
        field={{
          id: "size",
          type: "select",
          label: "Size",
          options: [
            { value: "s", label: "Small" },
            { value: "m", label: "Medium" },
          ],
        }}
        fieldId="size"
        value={undefined}
        onChange={() => {}}
      />
    );
    expect(screen.getByRole("combobox", { name: "Size" })).toBeTruthy();
  });
});

describe("FormFieldControl group labeling", () => {
  it("gives a radio group its field label as an accessible name", () => {
    const field: FormField = {
      id: "decision",
      type: "radio",
      label: "Overall direction",
      options: [
        {
          value: "approve",
          label: "Keep this direction",
          description: "Preserve the current approach.",
        },
        { value: "revise", label: "Revise it" },
      ],
    };
    render(
      <FormFieldControl
        field={field}
        fieldId="decision"
        value={undefined}
        onChange={() => {}}
      />
    );

    // Fails if aria-labelledby points at a non-existent id — the group
    // would then have no accessible name at all.
    expect(
      screen.getByRole("radiogroup", { name: "Overall direction" })
    ).toBeTruthy();
    expect(
      screen.getByRole("radio", { name: /Keep this direction/ })
    ).toBeTruthy();
    expect(screen.getByText("Preserve the current approach.")).toBeTruthy();
  });

  it("gives a multi-select checkbox group its field label as an accessible name", () => {
    const field: FormField = {
      id: "tags",
      type: "select",
      label: "Affected areas",
      multiple: true,
      options: [
        { value: "web", label: "Web" },
        { value: "server", label: "Server", description: "API and jobs." },
      ],
    };
    render(
      <FormFieldControl
        field={field}
        fieldId="tags"
        value={undefined}
        onChange={() => {}}
      />
    );

    expect(screen.getByRole("group", { name: "Affected areas" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Web" })).toBeTruthy();
    expect(screen.getByText("API and jobs.")).toBeTruthy();
  });
});
