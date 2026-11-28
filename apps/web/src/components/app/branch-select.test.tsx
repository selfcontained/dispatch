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

it("loads local branches on first open and reuses the list on reopen", async () => {
  stubLayout();
  vi.mocked(api).mockResolvedValue({ branches: ["trunk"] });
  render(<BranchSelect {...props} cwd="/repo" baseBranch="main" />, {
    wrapper: wrapper(),
  });
  const control = screen.getByRole("combobox", { name: "Base branch" });
  expect(api).not.toHaveBeenCalled();
  fireEvent.click(control);
  await screen.findByRole("option", { name: "trunk" });
  expect(vi.mocked(api).mock.calls).toEqual([
    ["/api/v1/git/branches?cwd=%2Frepo"],
  ]);
  fireEvent.click(control);
  fireEvent.click(control);
  await screen.findByRole("option", { name: "trunk" });
  expect(api).toHaveBeenCalledTimes(1);
});

it("keeps local branch order and never emits an empty local base", async () => {
  stubLayout();
  vi.mocked(api).mockResolvedValue({
    branches: ["trunk", "main"],
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
  const control = screen.getByRole("combobox", { name: "Base branch" });
  fireEvent.click(control);
  await screen.findByRole("option", { name: "trunk" });
  expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual([
    "trunk",
    "main",
  ]);
  fireEvent.click(screen.getByRole("option", { name: "trunk" }));
  fireEvent.click(control);
  fireEvent.click(screen.getByRole("option", { name: "main" }));
  expect(onBaseBranchChange.mock.calls).toEqual([["trunk"], ["main"]]);
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

const sources = {
  local: { cwd: "/repo" },
  runner: { sourceUrl: "/fixture/branches", defaultBaseBranch: "" },
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
  fireEvent.click(control);
  await screen.findByRole("option", { name: "feature/a" });
  return () =>
    screen.queryAllByRole("option").map((row) => ({
      text: row.textContent,
      selected: row.querySelector("svg")?.classList.contains("opacity-100"),
    }));
}

it.each(["local", "runner"] as const)(
  "%s keeps and flags an unlisted saved branch",
  async (source) => {
    const rows = await openRows(source, { baseBranch: "gone" });
    const options = rows();
    expect(options[0]).toEqual({ text: "gonenot found", selected: true });
    expect(screen.getByText(/no longer exists on the remote/)).toBeTruthy();
  }
);

it("keeps a missing local main selected and flagged", async () => {
  const rows = await openRows("local", { baseBranch: "main" });
  expect(rows()[0]).toEqual({ text: "mainnot found", selected: true });
});

it.each(["local", "runner"] as const)(
  "only offers listed branches when searching %s",
  async (source) => {
    const onBaseBranchChange = vi.fn();
    const rows = await openRows(source, {
      onBaseBranchChange,
    });
    const search = screen.getByPlaceholderText(/Search branches|GitHub PR URL/);
    for (const value of [
      "release/next",
      "https://github.com/example/repo/pull/7",
    ]) {
      fireEvent.change(search, { target: { value } });
      expect(rows().map((row) => row.text)).not.toContain(value);
    }
    fireEvent.change(search, { target: { value: "feature/a" } });
    fireEvent.click(screen.getByRole("option", { name: "feature/a" }));
    expect(onBaseBranchChange).toHaveBeenLastCalledWith("feature/a");
    expect(search.getAttribute("placeholder")).toBe("Search branches…");
  }
);

it.each(["release/not-fetched", "https://github.com/o/r/pull/7"])(
  "retains saved %s unchanged",
  async (baseBranch) => {
    const onBaseBranchChange = vi.fn();
    await openRows("runner", { baseBranch, onBaseBranchChange });
    expect(
      screen
        .getAllByRole("option")
        .some((option) => option.textContent === `${baseBranch}not found`)
    ).toBe(!baseBranch.startsWith("https://"));
    if (baseBranch.startsWith("https://"))
      expect(screen.queryByText(/no longer exists/)).toBeNull();
    fireEvent.keyDown(screen.getByPlaceholderText("Search branches…"), {
      key: "Escape",
    });
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Base branch" }).textContent
      ).toBe(baseBranch)
    );
    expect(onBaseBranchChange).not.toHaveBeenCalled();
  }
);

it("opens the list above a scrolling dialog body and returns focus on close", async () => {
  stubLayout();
  vi.mocked(api).mockResolvedValue({
    branches: ["trunk", "feature/a"],
    defaultBranch: "trunk",
  } as never);
  render(
    <div role="dialog" data-testid="dialog">
      <div data-testid="dialog-body" className="overflow-y-auto">
        <BranchSelect {...props} cwd="/repo" baseBranch="main" />
      </div>
    </div>,
    { wrapper: wrapper() }
  );
  const control = screen.getByRole("combobox", { name: "Base branch" });
  expect(control.textContent).toContain("main");
  control.focus();
  fireEvent.keyDown(control, { key: "ArrowDown" });
  const option = await screen.findByRole("option", { name: "feature/a" });
  // The shared combobox portals above the dialog body that scrolls and clips.
  expect(screen.getByTestId("dialog-body").contains(option)).toBe(false);
  const search = screen.getByPlaceholderText("Search branches…");
  await waitFor(() => expect(document.activeElement).toBe(search));
  fireEvent.keyDown(search, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("option", { name: "feature/a" })).toBeNull()
  );
  await waitFor(() => expect(document.activeElement).toBe(control));
});

it("keeps an earlier target's response out of the current dropdown", async () => {
  stubLayout();
  const first = Promise.withResolvers<{
    branches: string[];
    defaultBranch: string;
  }>();
  const second = Promise.withResolvers<{
    branches: string[];
    defaultBranch: string;
  }>();
  vi.mocked(api)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const view = render(
    <BranchSelect {...props} sourceUrl="/fixture/first" defaultBaseBranch="" />,
    { wrapper: wrapper() }
  );
  fireEvent.click(screen.getByTestId("branch-select-base-branch"));
  await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
  fireEvent.keyDown(screen.getByPlaceholderText("Search branches…"), {
    key: "Escape",
  });
  view.rerender(
    <BranchSelect {...props} sourceUrl="/fixture/second" defaultBaseBranch="" />
  );
  fireEvent.click(screen.getByTestId("branch-select-base-branch"));
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  await act(async () =>
    second.resolve({ branches: ["new-main"], defaultBranch: "new-main" })
  );
  expect(await screen.findByRole("option", { name: "new-main" })).toBeTruthy();
  await act(async () =>
    first.resolve({ branches: ["old-main"], defaultBranch: "old-main" })
  );
  expect(screen.queryByRole("option", { name: "old-main" })).toBeNull();
});

it("waits for its data URL and fetches it when an open dropdown becomes ready", async () => {
  stubLayout();
  vi.mocked(api).mockResolvedValue({
    branches: ["ready-branch"],
    defaultBranch: "ready-branch",
  });
  const view = render(
    <BranchSelect
      {...props}
      cwd="/controller-folder"
      sourceUrl=""
      defaultBaseBranch=""
    />,
    { wrapper: wrapper() }
  );
  fireEvent.click(screen.getByTestId("branch-select-base-branch"));
  expect(api).not.toHaveBeenCalled();
  expect(screen.getByText("Loading branches…")).toBeTruthy();
  view.rerender(
    <BranchSelect
      {...props}
      cwd="/controller-folder"
      sourceUrl="/fixture/ready"
      defaultBaseBranch=""
    />
  );
  expect(
    await screen.findByRole("option", { name: "ready-branch" })
  ).toBeTruthy();
  expect(vi.mocked(api).mock.calls).toEqual([["/fixture/ready"]]);
});

it("shows the reported default before opening without changing the implicit payload value", async () => {
  vi.mocked(api).mockResolvedValue({
    branches: ["master", "release"],
    defaultBranch: "master",
  });
  const changed = vi.fn();
  render(
    <BranchSelect
      {...props}
      sourceUrl="/fixture/default"
      defaultBaseBranch=""
      baseBranch=""
      onBaseBranchChange={changed}
    />,
    { wrapper: wrapper() }
  );
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Base branch" }).textContent
    ).toBe("master")
  );
  expect(changed).not.toHaveBeenCalled();
});

it("does not carry an old request's spinner into a disabled target", async () => {
  stubLayout();
  const first = Promise.withResolvers<{
    branches: string[];
    defaultBranch: string;
  }>();
  vi.mocked(api)
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue({ branches: ["master"], defaultBranch: "master" });
  const view = render(<BranchSelect {...props} sourceUrl="/fixture/first" />, {
    wrapper: wrapper(),
  });
  await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
  expect(
    screen
      .getByTestId("branch-select-base-branch")
      .querySelector(".animate-spin")
  ).not.toBeNull();
  view.rerender(
    <BranchSelect {...props} sourceUrl="/fixture/second" disabled />
  );
  await act(async () =>
    first.resolve({ branches: ["old"], defaultBranch: "old" })
  );
  const control = screen.getByTestId("branch-select-base-branch");
  expect(control).toHaveProperty("disabled", true);
  expect(control.querySelector(".animate-spin")).toBeNull();
  expect(api).toHaveBeenCalledTimes(1);
  view.rerender(<BranchSelect {...props} sourceUrl="/fixture/second" />);
  await waitFor(() => expect(control.textContent).toBe("master"));
  expect(control).toHaveProperty("disabled", false);
  expect(vi.mocked(api).mock.calls[1]).toEqual(["/fixture/second"]);
});
