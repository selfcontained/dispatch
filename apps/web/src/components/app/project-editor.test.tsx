// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Project } from "@/hooks/use-projects";
import { ProjectEditor } from "./project-editor";
import { readProjectLogoColors } from "./project-logo-color";

const { mutateRepository } = vi.hoisted(() => ({ mutateRepository: vi.fn() }));
vi.mock("@/hooks/use-repository-project", () => ({
  useRepositoryProject: () => ({ mutate: mutateRepository }),
}));
vi.mock("@/hooks/use-launch-targets", () => ({
  useLaunchTargets: () => ({
    list: {
      data: [
        {
          key: "runner-a",
          name: "Runner A",
          status: "online",
          location: { repositorySearchUrl: "/fixture/search" },
        },
      ],
    },
  }),
}));
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
});

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
    extraRoots: [],
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

it("creates a project from a repository URL on a chosen runner", async () => {
  mount();
  await act(async () => {});
  fireEvent.click(screen.getByRole("combobox", { name: "Source" }));
  fireEvent.click(screen.getByRole("option", { name: "Repository" }));
  await act(async () => {});
  expect(screen.queryByLabelText("Folder")).toBeNull();
  fireEvent.click(screen.getByRole("combobox", { name: "Repository" }));
  const url = "https://github.com/example/new-repo";
  fireEvent.change(
    screen.getByPlaceholderText(
      "Search projects or your repos, or paste a URL"
    ),
    { target: { value: url } }
  );
  const option = await screen.findByRole("option", { name: url });
  await act(async () => {});
  fireEvent.click(option);
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
    "new-repo"
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Create project",
      }) as HTMLButtonElement
    ).disabled
  ).toBe(false);
  fireEvent.submit(
    screen.getByRole("button", { name: "Create project" }).closest("form")!
  );
  expect(mutateRepository).toHaveBeenCalledWith(
    expect.objectContaining({ name: "new-repo", repository: url }),
    expect.anything()
  );
});
