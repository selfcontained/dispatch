// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/hooks/use-projects";
import { ProjectEditor } from "./project-editor";
import { readProjectLogoColors } from "./project-logo-color";

vi.mock("@/hooks/use-projects", () => ({
  useProjectActions: () => ({ mutate: vi.fn() }),
}));
vi.mock("./create-agent-dialog-utils", () => ({
  useCwdHistory: () => ({ history: [] }),
}));
vi.mock("@/lib/api", () => ({
  api: async () => ({
    dataUrl: "data:image/png;base64,logo",
    path: null,
    source: "repository",
  }),
}));
vi.mock("./project-logo-color", () => ({
  readProjectLogoColors: vi.fn(() => ["#ec3b80", "#00918c"]),
}));

afterEach(cleanup);

function mount(project?: Project) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProjectEditor project={project} onClose={vi.fn()} onSaved={vi.fn()} />
    </QueryClientProvider>
  );
}

function chooseFolder(folder: string) {
  fireEvent.change(screen.getByLabelText("Folder"), {
    target: { value: folder },
  });
}

function colorValue() {
  return (
    screen.getByRole("textbox", {
      name: "Project color hex",
    }) as HTMLInputElement
  ).value;
}

describe("project creation color", () => {
  it("suggests the logo color after the preview loads", async () => {
    mount();
    chooseFolder("/example");
    fireEvent.load(await screen.findByAltText("Project icon preview"));
    expect(colorValue()).toBe("#ec3b80");
    expect(
      screen.getByRole("button", { name: "Logo color #ec3b80", pressed: true })
    ).toBeTruthy();
  });

  it("preserves a manual pick, even when the user picked the default swatch", async () => {
    mount();
    chooseFolder("/example");
    fireEvent.click(screen.getByRole("button", { name: "Color #9575ed" }));
    fireEvent.load(await screen.findByAltText("Project icon preview"));
    expect(readProjectLogoColors).toHaveBeenCalled();
    expect(colorValue()).toBe("#9575ed");
    fireEvent.click(screen.getByRole("button", { name: "Logo color #00918c" }));
    expect(colorValue()).toBe("#00918c");
  });
});

it("offers logo colors on an existing project and keeps the saved color until a swatch is chosen", async () => {
  mount({
    id: "existing",
    name: "Existing project",
    repoRoot: "/example",
    color: "#74b85c",
    iconOverride: null,
    createdAt: "",
    updatedAt: "",
  });
  fireEvent.load(await screen.findByAltText("Project icon preview"));
  expect(colorValue()).toBe("#74b85c");
  fireEvent.click(screen.getByRole("button", { name: "Logo color #ec3b80" }));
  expect(colorValue()).toBe("#ec3b80");
});
