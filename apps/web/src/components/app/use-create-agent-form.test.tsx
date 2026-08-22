// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import type { ClipboardEvent, FormEvent, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONTEXT_PROMPT_ID,
  CWD_HISTORY_KEY,
  LAST_USED_CWD_KEY,
  LAST_USED_TYPE_KEY,
} from "@/components/app/create-agent-dialog-utils";
import type { Agent } from "@/components/app/types";
import type { AgentType } from "@/lib/agent-types";
import { createAgentModelPrefAtom, createNewBranchPrefAtom } from "@/lib/store";

import { useCreateAgentForm } from "./use-create-agent-form";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const { api } = await import("@/lib/api");
const { toast } = await import("sonner");
const apiMock = vi.mocked(api);
const toastErrorMock = vi.mocked(toast.error);

const createdAgent = {
  id: "agt_new",
  name: "created",
  type: "claude",
  status: "creating",
  cwd: "/repo/app",
  worktreePath: null,
  worktreeBranch: null,
  tmuxSession: "dispatch-agt_new",
  agentArgs: [],
  model: null,
  fullAccess: false,
  mediaDir: null,
  createdAt: "2026-07-31T00:00:00.000Z",
  updatedAt: "2026-07-31T00:00:00.000Z",
} as Agent;

let queryClient: QueryClient;
// Fresh jotai store per test so a setCreateNewBranch in one test can't leak
// into later tests using the same cwd. The store alone is not enough: the
// createNewBranch atom family caches atoms per cwd at module scope, and
// atomWithLocalStorage bakes its localStorage read into the atom at creation
// time — so the family is also purged in afterEach, or a test that seeds
// dispatch:createNewBranch:* in localStorage would be silently ignored.
let jotaiStore: ReturnType<typeof createStore>;
let createObjectURLMock: ReturnType<typeof vi.fn>;
let revokeObjectURLMock: ReturnType<typeof vi.fn>;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <JotaiProvider store={jotaiStore}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </JotaiProvider>
  );
}

type SetupOverrides = Partial<{
  enabledAgentTypes: AgentType[];
  initialAgentType: AgentType | null;
  resolveDefaultCwd: () => string;
  onCreated: (agent: Agent, agentType: AgentType) => Promise<void>;
}>;

async function setup(overrides: SetupOverrides = {}) {
  const onCreated = overrides.onCreated ?? vi.fn().mockResolvedValue(undefined);
  const view = renderHook(
    (props: Required<SetupOverrides>) => useCreateAgentForm(props),
    {
      wrapper,
      initialProps: {
        enabledAgentTypes: ["claude", "codex"] as AgentType[],
        initialAgentType: null,
        resolveDefaultCwd: () => "/repo/app",
        onCreated,
        ...overrides,
      },
    }
  );
  // Flush the mount-time queries (system defaults, cwd history) so their
  // resolutions don't fire outside act() mid-test. This relies on async act
  // yielding macrotasks — react-query v5 notifies via setTimeout(0), not
  // microtasks.
  await act(async () => {});
  return { ...view, onCreated };
}

function submitEvent(): FormEvent<HTMLFormElement> {
  return { preventDefault: vi.fn() } as unknown as FormEvent<HTMLFormElement>;
}

/** The POST /api/v1/agents call, or undefined if none was made. */
function agentsPost(): [string, RequestInit] | undefined {
  return apiMock.mock.calls.find(([path]) => path === "/api/v1/agents") as
    | [string, RequestInit]
    | undefined;
}

function agentsPostJson(): Record<string, unknown> {
  const call = agentsPost();
  expect(call).toBeDefined();
  expect(call![1].method).toBe("POST");
  return JSON.parse(call![1].body as string);
}

function file(name: string, type: string, lastModified = 1): File {
  return new File(["content"], name, { type, lastModified });
}

function pasteEvent(options: {
  targetId?: string;
  files?: File[];
  text?: string;
}): ClipboardEvent<HTMLElement> {
  const target = document.createElement("textarea");
  if (options.targetId) target.id = options.targetId;
  return {
    target,
    preventDefault: vi.fn(),
    clipboardData: {
      items: (options.files ?? []).map((f) => ({
        kind: "file",
        getAsFile: () => f,
      })),
      getData: () => options.text ?? "",
    },
  } as unknown as ClipboardEvent<HTMLElement>;
}

beforeEach(() => {
  window.localStorage.clear();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  jotaiStore = createStore();
  apiMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/v1/history/projects")) return { projects: [] };
    if (path === "/api/v1/system/defaults") return { homeDir: "/home/srv" };
    if (path === "/api/v1/agents") return { agent: createdAgent };
    throw new Error(`unexpected api call: ${path}`);
  });
  createObjectURLMock = vi.fn(
    (f: File) => `blob:${(f as File & { name: string }).name}`
  );
  revokeObjectURLMock = vi.fn();
  URL.createObjectURL = createObjectURLMock as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeObjectURLMock as typeof URL.revokeObjectURL;
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  // restoreAllMocks alone stops resetting module-factory vi.fn() mocks in
  // vitest 3 — reset explicitly so call history and implementations never
  // leak across tests.
  apiMock.mockReset();
  toastErrorMock.mockReset();
  vi.mocked(toast.success).mockReset();
  // Drop cached per-cwd atoms so each test's atomWithLocalStorage initial
  // read happens against that test's localStorage state.
  createNewBranchPrefAtom.setShouldRemove(() => true);
  createNewBranchPrefAtom.setShouldRemove(null);
});

describe("agent type seeding", () => {
  it("uses initialAgentType when it is enabled", async () => {
    const { result } = await setup({ initialAgentType: "codex" });
    expect(result.current.createType).toBe("codex");
  });

  it("falls back to the first enabled type when the preferred type is disabled", async () => {
    const { result } = await setup({
      enabledAgentTypes: ["claude"],
      initialAgentType: "codex",
    });
    expect(result.current.createType).toBe("claude");
  });

  it("uses the stored last-used type when no initial type is given", async () => {
    window.localStorage.setItem(LAST_USED_TYPE_KEY, "codex");
    const { result } = await setup();
    expect(result.current.createType).toBe("codex");
  });

  it("re-snaps the type when it drops out of the enabled list", async () => {
    const { result, rerender, onCreated } = await setup({
      initialAgentType: "codex",
    });
    expect(result.current.createType).toBe("codex");

    rerender({
      enabledAgentTypes: ["claude"] as AgentType[],
      initialAgentType: "codex",
      resolveDefaultCwd: () => "/repo/app",
      onCreated,
    });
    expect(result.current.createType).toBe("claude");
  });
});

describe("cwd seeding", () => {
  it("uses the trimmed resolveDefaultCwd value", async () => {
    const { result } = await setup({
      resolveDefaultCwd: () => "  /repo/spaced  ",
    });
    expect(result.current.createCwd).toBe("/repo/spaced");
  });

  it("falls back to the stored last-used cwd, then to ~/", async () => {
    window.localStorage.setItem(LAST_USED_CWD_KEY, "/last/used");
    const stored = await setup({ resolveDefaultCwd: () => "" });
    expect(stored.result.current.createCwd).toBe("/last/used");
    stored.unmount();

    window.localStorage.clear();
    const bare = await setup({ resolveDefaultCwd: () => "" });
    expect(bare.result.current.createCwd).toBe("~/");
  });
});

describe("startup files and links", () => {
  it("dedupes files by key and creates previews only for images", async () => {
    const img = file("shot.png", "image/png");
    const txt = file("notes.txt", "text/plain");
    const { result } = await setup();

    act(() => result.current.appendStartupFiles([img, txt]));
    expect(result.current.startupFiles).toEqual([img, txt]);
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    expect(createObjectURLMock).toHaveBeenCalledWith(img);

    // Same name/size/lastModified — must not duplicate or re-create a URL.
    act(() =>
      result.current.appendStartupFiles([file("shot.png", "image/png")])
    );
    expect(result.current.startupFiles).toHaveLength(2);
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
  });

  it("revokes the preview when a file is removed", async () => {
    const img = file("shot.png", "image/png");
    const other = file("keep.png", "image/png");
    const { result } = await setup();
    act(() => result.current.appendStartupFiles([img, other]));

    act(() => result.current.handleRemoveStartupFile(img));
    expect(result.current.startupFiles).toEqual([other]);
    expect(revokeObjectURLMock).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:shot.png");
  });

  it("revokes all remaining previews on unmount", async () => {
    const { result, unmount } = await setup();
    act(() =>
      result.current.appendStartupFiles([
        file("a.png", "image/png"),
        file("b.png", "image/png"),
      ])
    );

    unmount();
    expect(revokeObjectURLMock).toHaveBeenCalledTimes(2);
    expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:a.png");
    expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:b.png");
  });
});

describe("handleStartupPaste", () => {
  it("ignores pastes outside the context prompt", async () => {
    const { result } = await setup();
    const event = pasteEvent({ files: [file("shot.png", "image/png")] });

    act(() => result.current.handleStartupPaste(event));
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(result.current.startupFiles).toEqual([]);
  });

  it("consumes pasted files before considering text", async () => {
    const img = file("shot.png", "image/png");
    const { result } = await setup();
    const event = pasteEvent({
      targetId: CONTEXT_PROMPT_ID,
      files: [img],
      text: "https://example.com",
    });

    act(() => result.current.handleStartupPaste(event));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(result.current.startupFiles).toEqual([img]);
    expect(result.current.startupLinks).toEqual([]);
  });

  it("captures pasted URLs as links, deduped", async () => {
    const { result } = await setup();
    const event = pasteEvent({
      targetId: CONTEXT_PROMPT_ID,
      text: "example.com/docs",
    });

    act(() => result.current.handleStartupPaste(event));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(result.current.startupLinks).toEqual(["https://example.com/docs"]);

    const again = pasteEvent({
      targetId: CONTEXT_PROMPT_ID,
      text: "example.com/docs",
    });
    act(() => result.current.handleStartupPaste(again));
    expect(result.current.startupLinks).toEqual(["https://example.com/docs"]);
  });

  it("leaves plain text pastes to the textarea", async () => {
    const { result } = await setup();
    const event = pasteEvent({
      targetId: CONTEXT_PROMPT_ID,
      text: "just some notes",
    });

    act(() => result.current.handleStartupPaste(event));
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(result.current.startupLinks).toEqual([]);
    expect(result.current.initialPrompt).toBe("");
  });
});

describe("handleClipboardText", () => {
  it("replaces an empty prompt and appends to a non-empty one", async () => {
    const { result } = await setup();

    act(() => result.current.handleClipboardText("first block"));
    expect(result.current.initialPrompt).toBe("first block");

    act(() => result.current.handleClipboardText("second block"));
    expect(result.current.initialPrompt).toBe("first block\n\nsecond block");
  });
});

describe("handleSubmit", () => {
  it("does nothing when the cwd is blank", async () => {
    const { result } = await setup();
    act(() => result.current.setCreateCwd("   "));

    await act(async () => result.current.handleSubmit(submitEvent()));
    expect(agentsPost()).toBeUndefined();
    expect(result.current.creating).toBe(false);
  });

  it("clears the new branch preference when worktree creation is disabled", async () => {
    const { result } = await setup();

    expect(result.current.createNewBranch).toBe(true);
    act(() => result.current.setCreateUseWorktree(false));

    expect(result.current.createUseWorktree).toBe(false);
    expect(result.current.createNewBranch).toBe(false);
  });

  it("sends the default JSON payload and omits context-only fields on the config step", async () => {
    const { result } = await setup();
    act(() => result.current.setCreateName("  my agent  "));
    // Prompt typed but still on the config step — must not be sent.
    act(() => result.current.setInitialPrompt("draft prompt"));

    await act(async () => result.current.handleSubmit(submitEvent()));
    expect(agentsPostJson()).toEqual({
      name: "my agent",
      cwd: "/repo/app",
      type: "claude",
      fullAccess: false,
      autoReview: false,
      useWorktree: true,
      createNewBranch: true,
    });
  });

  it("forces useWorktree off when the cwd is not a git repo", async () => {
    const { result } = await setup();
    act(() => result.current.handlePathInfoChange({ isGitRepo: false }));
    act(() => result.current.setCreateBaseBranch("develop"));
    act(() => result.current.setCreateWorktreeBranch("feat/x"));

    await act(async () => result.current.handleSubmit(submitEvent()));
    const body = agentsPostJson();
    expect(body.useWorktree).toBe(false);
    expect(body).not.toHaveProperty("createNewBranch");
    expect(body).not.toHaveProperty("worktreeBranch");
    expect(body).not.toHaveProperty("baseBranch");
  });

  it("sends branch fields when a worktree is requested off main", async () => {
    const { result } = await setup();
    act(() => result.current.handlePathInfoChange({ isGitRepo: true }));
    act(() => result.current.setCreateBaseBranch("develop"));
    act(() => result.current.setCreateWorktreeBranch("  feat/x  "));

    await act(async () => result.current.handleSubmit(submitEvent()));
    const body = agentsPostJson();
    expect(body.useWorktree).toBe(true);
    expect(body.createNewBranch).toBe(true);
    expect(body.worktreeBranch).toBe("feat/x");
    expect(body.baseBranch).toBe("develop");
  });

  it("drops the worktree branch when not creating a new branch", async () => {
    const { result } = await setup();
    act(() => result.current.setCreateNewBranch(false));
    act(() => result.current.setCreateWorktreeBranch("feat/x"));

    await act(async () => result.current.handleSubmit(submitEvent()));
    const body = agentsPostJson();
    expect(body.createNewBranch).toBe(false);
    expect(body).not.toHaveProperty("worktreeBranch");
  });

  it("sends the trimmed prompt on the context step, omitting it when blank", async () => {
    const { result } = await setup();
    act(() => result.current.enterContextStep());
    act(() => result.current.setInitialPrompt("  do things  "));

    await act(async () => result.current.handleSubmit(submitEvent()));
    expect(agentsPostJson().initialPrompt).toBe("do things");

    apiMock.mockClear();
    apiMock.mockImplementation(async () => ({ agent: createdAgent }));
    act(() => result.current.setInitialPrompt("   "));
    await act(async () => result.current.handleSubmit(submitEvent()));
    expect(agentsPostJson()).not.toHaveProperty("initialPrompt");
  });

  it("switches to FormData when context files or links exist, skipping empty fields", async () => {
    const img = file("shot.png", "image/png");
    const { result } = await setup();
    act(() => result.current.enterContextStep());
    act(() => result.current.appendStartupFiles([img]));
    act(() => result.current.handleAddLink("https://example.com"));
    act(() => result.current.setInitialPrompt("look at these"));

    await act(async () => result.current.handleSubmit(submitEvent()));
    const call = agentsPost();
    expect(call).toBeDefined();
    expect(call![1].method).toBe("POST");
    const body = call![1].body as FormData;
    expect(body).toBeInstanceOf(FormData);
    // Empty name is skipped; false booleans are stringified, not dropped.
    expect(body.get("name")).toBeNull();
    expect(body.get("fullAccess")).toBe("false");
    expect(body.get("autoReview")).toBe("false");
    expect(body.get("useWorktree")).toBe("true");
    expect(body.get("createNewBranch")).toBe("true");
    expect(body.get("worktreeBranch")).toBeNull();
    expect(body.get("baseBranch")).toBeNull();
    expect(body.get("cwd")).toBe("/repo/app");
    expect(body.get("initialPrompt")).toBe("look at these");
    expect(body.get("startupLinks")).toBe(
      JSON.stringify(["https://example.com"])
    );
    expect(body.getAll("startupFiles")).toEqual([img]);
  });

  it("stays JSON on the config step even when files are attached", async () => {
    const { result } = await setup();
    act(() =>
      result.current.appendStartupFiles([file("shot.png", "image/png")])
    );

    await act(async () => result.current.handleSubmit(submitEvent()));
    const call = agentsPost();
    expect(call).toBeDefined();
    expect(typeof call![1].body).toBe("string");
  });

  it("omits a persisted model until the catalog confirms it", async () => {
    jotaiStore.set(createAgentModelPrefAtom("claude:/repo/app"), "retired");
    const { result } = await setup({ initialAgentType: "claude" });

    await act(async () => result.current.handleSubmit(submitEvent()));

    expect(agentsPostJson().model).toBeUndefined();
  });

  it("records last-used values and hands the created agent to onCreated", async () => {
    const { result, onCreated } = await setup({
      initialAgentType: "codex",
      resolveDefaultCwd: () => "/repo/created",
    });

    await act(async () => result.current.handleSubmit(submitEvent()));
    expect(window.localStorage.getItem(LAST_USED_CWD_KEY)).toBe(
      "/repo/created"
    );
    expect(window.localStorage.getItem(LAST_USED_TYPE_KEY)).toBe("codex");
    expect(
      JSON.parse(window.localStorage.getItem(CWD_HISTORY_KEY) ?? "[]")[0]
    ).toBe("/repo/created");
    expect(onCreated).toHaveBeenCalledWith(createdAgent, "codex");
    expect(result.current.creating).toBe(false);
  });

  it("surfaces API failures via toast and resets the creating flag", async () => {
    const { result, onCreated } = await setup();
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/api/v1/agents") throw new Error("boom");
      return { projects: [], homeDir: "/home/srv" };
    });

    await act(async () => result.current.handleSubmit(submitEvent()));
    expect(toastErrorMock).toHaveBeenCalledWith("boom");
    expect(onCreated).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(LAST_USED_CWD_KEY)).toBeNull();
    expect(result.current.creating).toBe(false);
  });

  it("falls back to a generic message for non-Error failures", async () => {
    const { result } = await setup();
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/api/v1/agents") throw "string failure";
      return { projects: [], homeDir: "/home/srv" };
    });

    await act(async () => result.current.handleSubmit(submitEvent()));
    expect(toastErrorMock).toHaveBeenCalledWith("Failed to create agent.");
  });
});

describe("worktree checkbox state vs. cwd repo-ness", () => {
  it("forces both checkboxes off once the cwd is confirmed not a git repo", async () => {
    const { result } = await setup();
    expect(result.current.createUseWorktree).toBe(true);
    expect(result.current.createNewBranch).toBe(true);

    act(() => result.current.handlePathInfoChange({ isGitRepo: false }));

    expect(result.current.createUseWorktree).toBe(false);
    expect(result.current.createNewBranch).toBe(false);
    expect(result.current.worktreeChecked).toBe(false);
  });

  it("does not spuriously re-check once the cwd becomes a repo again", async () => {
    const { result } = await setup();

    act(() => result.current.handlePathInfoChange({ isGitRepo: false }));
    expect(result.current.createUseWorktree).toBe(false);

    act(() => result.current.handlePathInfoChange({ isGitRepo: true }));

    expect(result.current.worktreeAvailable).toBe(true);
    expect(result.current.createUseWorktree).toBe(false);
    expect(result.current.createNewBranch).toBe(false);
    expect(result.current.worktreeChecked).toBe(false);
  });

  it("leaves the preference untouched while repo-ness is still unknown", async () => {
    const { result } = await setup();

    // handlePathInfoChange(null) is what PathInput sends while a debounced
    // validation is in flight — must not be treated as "confirmed not a repo".
    act(() => result.current.handlePathInfoChange(null));

    expect(result.current.createUseWorktree).toBe(true);
    expect(result.current.createNewBranch).toBe(true);
  });
});
