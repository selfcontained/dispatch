// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { BranchSelect } from "./branch-select";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("shows one selected default when starting a new branch from the explicit default", async () => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
  vi.mocked(api).mockResolvedValue({
    branches: ["trunk", "topic"],
    defaultBranch: "trunk",
  } as never);
  const runner = {
    id: "runner-a",
    repository: "https://github.com/example/first",
    browse: true,
  };
  const { rerender } = render(
    <BranchSelect
      {...props}
      runner={runner}
      baseBranch="trunk"
      allowPullRequest
    />,
    { wrapper: wrapper() }
  );
  const control = screen.getByRole("combobox", { name: "Base branch" });
  fireEvent.click(control);
  await screen.findByRole("option", { name: "topic" });
  rerender(<BranchSelect {...props} runner={runner} baseBranch="trunk" />);
  const defaultRows = screen.getAllByRole("option", { name: "trunk" });
  expect(defaultRows).toHaveLength(1);
  expect(defaultRows[0]?.querySelector("svg")?.classList).toContain(
    "opacity-100"
  );
});

const props = {
  cwd: "",
  baseBranch: "",
  onBaseBranchChange: vi.fn(),
  worktreeBranch: "",
  onWorktreeBranchChange: vi.fn(),
  showNewBranchInput: false,
};

function wrapper() {
  const client = new QueryClient();
  return function WithQueries({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

it.each([
  { id: "runner-a", repository: "https://github.com/example/second" },
  { id: "runner-b", repository: "https://github.com/example/first" },
])(
  "keeps a superseded branch response out of the active selection: %j",
  async (current) => {
    type Branches = { branches: string[]; defaultBranch: string };
    const old = Promise.withResolvers<Branches>();
    const newer = Promise.withResolvers<Branches>();
    const request = vi
      .mocked(api)
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(newer.promise);
    const { rerender } = render(
      <BranchSelect
        {...props}
        runner={{
          id: "runner-a",
          repository: "https://github.com/example/first",
          browse: true,
        }}
      />,
      { wrapper: wrapper() }
    );
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    rerender(<BranchSelect {...props} runner={{ ...current, browse: true }} />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await act(async () =>
      newer.resolve({ branches: ["new-main"], defaultBranch: "new-main" })
    );
    const control = screen.getByRole("combobox", { name: "Base branch" });
    await waitFor(() => expect(control.textContent).toContain("new-main"));
    await act(async () =>
      old.resolve({ branches: ["old-main"], defaultBranch: "old-main" })
    );
    expect(control.textContent).toContain("new-main");
  }
);
