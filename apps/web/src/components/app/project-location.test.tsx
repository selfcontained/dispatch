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
    fireEvent.click(screen.getByRole("button", { name: "Folder" }));
    expect(
      screen
        .getByRole("button", { name: "Folder" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    fireEvent.change(field, { target: { value: "/edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    expect(
      screen.getByRole("button", { name: "Choose project" }).textContent
    ).toContain("Second");
    expect(screen.getByLabelText("Folder path")).toBe(field);
    expect((field as HTMLInputElement).value).toBe("/edited");
  });
  it("bounds the project menu by the room Radix measures, so an upward flip stays on screen", () => {
    render(
      <ProjectLocation projectId="first" onChange={() => {}}>
        <input aria-label="Folder path" />
      </ProjectLocation>
    );
    const trigger = screen.getByRole("button", { name: "Choose project" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    const menu = screen.getByRole("menu");
    expect(menu.className).toContain(
      "max-h-[min(18rem,var(--radix-dropdown-menu-content-available-height))]"
    );
    expect(menu.className).not.toMatch(/(^|\s)max-h-72(\s|$)/);
  });
});
