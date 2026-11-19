// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectEditor } from "./project-editor";
import { readProjectLogoColor } from "./project-logo-color";

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
  readProjectLogoColor: vi.fn(() => "#ec3b80"),
}));

afterEach(cleanup);

function mount() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProjectEditor onClose={vi.fn()} onSaved={vi.fn()} />
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
  });

  it("preserves a manual pick, even when the user picked the default swatch", async () => {
    mount();
    chooseFolder("/example");
    fireEvent.click(screen.getByRole("button", { name: "Color #9575ed" }));
    fireEvent.load(await screen.findByAltText("Project icon preview"));
    expect(readProjectLogoColor).toHaveBeenCalled();
    expect(colorValue()).toBe("#9575ed");
  });
});
