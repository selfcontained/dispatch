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
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { BranchSelect, branchRows } from "./branch-select";

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

it("offers the local repository default and keeps main selectable on a trunk repo", async () => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
  vi.mocked(api).mockResolvedValue({
    branches: ["main", "trunk"],
    defaultBranch: "trunk",
  });
  const onBaseBranchChange = vi.fn();
  render(
    <BranchSelect
      {...props}
      cwd="/repo"
      baseBranch="main"
      onBaseBranchChange={onBaseBranchChange}
    />,
    { wrapper: wrapper() }
  );
  fireEvent.click(screen.getByRole("combobox", { name: "Base branch" }));
  const trunk = await screen.findByRole("option", { name: "trunk" });
  expect(screen.getByRole("option", { name: "main" })).toBeTruthy();
  fireEvent.click(trunk);
  expect(onBaseBranchChange).toHaveBeenCalledWith("");
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

// One picker model for both sources: equivalent data renders identical rows.
const sources = {
  local: { cwd: "/repo" },
  runner: {
    runner: {
      id: "runner-a",
      repository: "https://github.com/example/repo",
      browse: true,
    },
  },
} as const;

function stubLayout() {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
}

async function openRows(
  source: keyof typeof sources,
  extra: Partial<React.ComponentProps<typeof BranchSelect>> = {}
) {
  stubLayout();
  vi.mocked(api).mockResolvedValue({
    branches: ["trunk", "feature/a", "feature/b"],
    defaultBranch: "trunk",
  } as never);
  render(<BranchSelect {...props} {...sources[source]} {...extra} />, {
    wrapper: wrapper(),
  });
  const control = screen.getByRole("combobox", { name: "Base branch" });
  // Both sources load before the menu opens and name the default.
  await waitFor(() =>
    expect(control.textContent).toContain(extra.baseBranch || "trunk")
  );
  expect(api).toHaveBeenCalledTimes(1);
  fireEvent.click(control);
  await screen.findByRole("option", { name: "feature/a" });
  return () =>
    screen.getAllByRole("option").map((row) => ({
      text: row.textContent,
      selected: row.querySelector("svg")?.classList.contains("opacity-100"),
    }));
}

describe.each(["local", "runner"] as const)("%s branch picker", (source) => {
  it("lists the default first, then the branches", async () => {
    const rows = await openRows(source);
    expect(rows()).toEqual([
      { text: "trunk", selected: true },
      { text: "feature/a", selected: false },
      { text: "feature/b", selected: false },
    ]);
  });

  it("flags a saved branch that is no longer listed", async () => {
    const rows = await openRows(source, { baseBranch: "gone" });
    expect(rows()[1]).toEqual({ text: "gonenot found", selected: true });
    expect(screen.getByText(/no longer exists on the remote/)).toBeTruthy();
  });

  it("accepts a typed branch and a pull request URL", async () => {
    const onBaseBranchChange = vi.fn();
    const rows = await openRows(source, {
      allowPullRequest: true,
      onBaseBranchChange,
    });
    const search = screen.getByPlaceholderText("Branch name or GitHub PR URL");
    fireEvent.change(search, { target: { value: "release/next" } });
    expect(rows().map((row) => row.text)).toContain("release/next");
    fireEvent.click(screen.getByRole("option", { name: "release/next" }));
    expect(onBaseBranchChange).toHaveBeenLastCalledWith("release/next");

    fireEvent.click(screen.getByRole("combobox", { name: "Base branch" }));
    const pr = "https://github.com/example/repo/pull/7";
    fireEvent.change(
      screen.getByPlaceholderText("Branch name or GitHub PR URL"),
      { target: { value: pr } }
    );
    fireEvent.click(await screen.findByRole("option", { name: pr }));
    expect(onBaseBranchChange).toHaveBeenLastCalledWith(pr);
  });
});

it("builds the same rows for any source and offers PR URLs only when allowed", () => {
  const data = {
    branches: ["trunk", "a"],
    defaultBranch: "trunk",
    baseBranch: "",
    listed: true,
  };
  const pr = "https://github.com/o/r/pull/1";
  expect(
    branchRows({ ...data, typed: pr, allowPullRequest: false }).map(
      (row) => row.value
    )
  ).toEqual(["", "a"]);
  expect(
    branchRows({ ...data, typed: pr, allowPullRequest: true }).map(
      (row) => row.value
    )
  ).toEqual(["", pr, "a"]);
  // A branch entered by hand is not flagged as missing.
  expect(
    branchRows({
      ...data,
      baseBranch: "typed",
      typed: "",
      allowPullRequest: false,
      entered: "typed",
    })[1]
  ).toMatchObject({ value: "typed", missing: false, selected: true });
});

it("opens the list above a scrolling dialog body and returns focus on close", async () => {
  stubLayout();
  vi.mocked(api).mockResolvedValue({
    branches: ["trunk", "feature/a"],
    defaultBranch: "trunk",
  } as never);
  render(
    <div role="dialog" data-testid="dialog">
      <div data-testid="dialog-body" className="overflow-y-auto">
        <BranchSelect {...props} cwd="/repo" />
      </div>
    </div>,
    { wrapper: wrapper() }
  );
  const control = screen.getByRole("combobox", { name: "Base branch" });
  await waitFor(() => expect(control.textContent).toContain("trunk"));
  control.focus();
  fireEvent.keyDown(control, { key: "ArrowDown" });
  const option = await screen.findByRole("option", { name: "feature/a" });
  // Portalled into the dialog, outside the body that scrolls and clips.
  expect(screen.getByTestId("dialog-body").contains(option)).toBe(false);
  expect(screen.getByTestId("dialog").contains(option)).toBe(true);
  const search = screen.getByPlaceholderText("Search or enter a branch");
  await waitFor(() => expect(document.activeElement).toBe(search));
  fireEvent.keyDown(search, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("option", { name: "feature/a" })).toBeNull()
  );
  await waitFor(() => expect(document.activeElement).toBe(control));
});
