// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectLocation } from "./project-location";
const { projects } = vi.hoisted(() => ({
  projects: [
    {
      id: "first",
      name: "First",
      repoRoot: "/first",
      color: "#9575ed",
      iconOverride: "A",
    },
    {
      id: "second",
      name: "Second",
      repoRoot: "/second",
      color: "#38b7a0",
      iconOverride: "B",
    },
  ],
}));
vi.mock("@/hooks/use-projects", () => ({
  useProjects: () => ({ data: projects }),
}));
afterEach(cleanup);
Element.prototype.scrollIntoView = () => {};
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
describe("project location", () => {
  it("returns to the chosen project and retains the folder field across switches", () => {
    function Form() {
      const [id, setId] = useState<string | null>("second");
      return (
        <ProjectLocation projectId={id} onChange={(p) => setId(p?.id ?? null)}>
          <input aria-label="Folder path" defaultValue="/scratch" />
        </ProjectLocation>
      );
    }
    render(<Form />);
    const field = screen.getByLabelText("Folder path");
    fireEvent.click(screen.getByRole("radio", { name: "Folder" }));
    expect(
      screen.getByRole("radio", { name: "Folder" }).getAttribute("aria-checked")
    ).toBe("true");
    fireEvent.change(field, { target: { value: "/edited" } });
    fireEvent.click(screen.getByRole("radio", { name: "Project" }));
    expect(
      screen.getByRole("combobox", { name: "Choose project" }).textContent
    ).toContain("Second");
    expect(screen.getByLabelText("Folder path")).toBe(field);
    expect((field as HTMLInputElement).value).toBe("/edited");
  });
  it("bounds the project menu by the measured room with a usable minimum", () => {
    render(
      <ProjectLocation projectId="first" onChange={() => {}}>
        <input aria-label="Folder path" />
      </ProjectLocation>
    );
    const trigger = screen.getByRole("combobox", { name: "Choose project" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = screen.getByRole("listbox");
    expect(menu.className).toContain(
      "max-h-[clamp(4rem,var(--radix-select-content-available-height),18rem)]"
    );
    expect(menu.className).not.toMatch(/(^|\s)max-h-72(\s|$)/);
  });
});

it("keeps Folder mode markup identical when the unified project picker is available", () => {
  const props = { projectId: null, onChange: () => {} };
  const view = render(
    <ProjectLocation {...props}>
      <input aria-label="Folder path" defaultValue="/scratch" />
    </ProjectLocation>
  );
  const before = view.container.innerHTML;
  view.rerender(
    <ProjectLocation {...props} projectPicker={<button>Unified picker</button>}>
      <input aria-label="Folder path" defaultValue="/scratch" />
    </ProjectLocation>
  );
  expect(view.container.innerHTML).toBe(before);
});

it("puts a selected project folder caption outside the unified picker's layout", () => {
  const props = {
    onChange: () => {},
    projectPicker: <button>Unified picker</button>,
  };
  const view = render(
    <ProjectLocation {...props} projectId={null}>
      <input aria-label="Folder path" />
    </ProjectLocation>
  );
  fireEvent.click(screen.getByRole("radio", { name: "Project" }));
  expect(screen.queryByText("/first", { exact: true })).toBeNull();
  view.rerender(
    <ProjectLocation {...props} projectId="first">
      <input aria-label="Folder path" />
    </ProjectLocation>
  );
  const caption = screen.getByText("/first", { exact: true });
  expect(caption.parentElement?.classList.contains("absolute")).toBe(true);
  expect(caption.parentElement?.classList.contains("top-full")).toBe(true);
});
