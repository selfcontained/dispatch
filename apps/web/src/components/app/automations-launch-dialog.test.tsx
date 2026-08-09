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
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";
import type { Template } from "@/hooks/use-templates";

import { LaunchTemplateDialog } from "./automations-launch-dialog";

// The dialog renders its real children and the real useTemplateActions
// mutation; only the HTTP seam and toast sink are mocked. That pins the whole
// launch contract end to end: form state -> mutation input -> wire payload
// (JSON vs multipart), which is exactly what a stubbed launchTemplate mock
// could silently get wrong.
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const { api } = await import("@/lib/api");
const { toast } = await import("sonner");
const apiMock = vi.mocked(api);
const toastErrorMock = vi.mocked(toast.error);

function makeTemplate(overrides: Partial<Template> = {}): Template {
  return {
    id: "tpl_1",
    directory: "/repo",
    name: "Nightly Audit",
    description: null,
    prompt: null,
    agentType: "claude",
    model: null,
    useWorktree: false,
    baseBranch: null,
    branchName: null,
    fullAccess: false,
    callable: false,
    allowMedia: false,
    selfImprove: false,
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
    ...overrides,
  };
}

function makeAgent(id: string): Agent {
  return {
    id,
    name: "launched",
    type: "claude",
    status: "running",
    cwd: "/repo",
    worktreePath: null,
    worktreeBranch: null,
    tmuxSession: `dispatch-${id}`,
    agentArgs: [],
    fullAccess: false,
    mediaDir: null,
    model: null,
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
  };
}

function LocationProbe(): JSX.Element {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

async function renderDialog(template: Template) {
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <LaunchTemplateDialog
          template={template}
          open
          onOpenChange={onOpenChange}
          agentTypes={["claude", "codex"]}
        />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  );
  if (template.agentType !== "terminal") {
    // The launch payload only carries a model once the catalog has arrived, so
    // every test starts from the settled state the user actually sees.
    await waitFor(() => expect(modelSelect().disabled).toBe(false));
  }
  return { onOpenChange };
}

function agentTypeSelect(): HTMLButtonElement {
  return screen.getByRole("combobox", {
    name: /agent type/i,
  }) as HTMLButtonElement;
}

function modelSelect(): HTMLButtonElement {
  return screen.getByTestId("launch-template-model") as HTMLButtonElement;
}

async function pickModel(name: RegExp): Promise<void> {
  fireEvent.click(modelSelect());
  fireEvent.click(await screen.findByRole("option", { name }));
}

function launchButton(): HTMLButtonElement {
  // While pending the ActivityBars spinner (aria-label "Loading") joins the
  // accessible name, so match loosely enough to cover both states.
  return screen.getByRole("button", { name: /Launch/ }) as HTMLButtonElement;
}

// The dialog content is portaled to document.body; there is exactly one form.
function dialogForm(): HTMLFormElement {
  const form = document.querySelector("form");
  if (!form) throw new Error("launch dialog form not found");
  return form;
}

function file(name: string, type: string): File {
  // Fixed lastModified keeps startupFileKey stable so duplicate drops dedupe.
  return new File(["content"], name, { type, lastModified: 1 });
}

function dropFiles(target: Element, files: File[]): void {
  fireEvent.drop(target, { dataTransfer: { files, types: ["Files"] } });
}

const LAUNCH_PATH = "/api/v1/templates/tpl_1/launch";

// The dialog also fetches the model catalog, so call-count assertions have to
// look at launch calls specifically rather than the api mock as a whole.
function launchCalls(): unknown[][] {
  return apiMock.mock.calls.filter((call) => call[0] === LAUNCH_PATH);
}

function lastCallBody(): unknown {
  const call = launchCalls().at(-1);
  if (!call) throw new Error("launch was not called");
  const init = call[1] as { method: string; body: unknown };
  expect(init.method).toBe("POST");
  return init.body;
}

function lastJsonBody(): Record<string, unknown> {
  const body = lastCallBody();
  expect(typeof body).toBe("string");
  return JSON.parse(body as string) as Record<string, unknown>;
}

const MODEL_CATALOG = {
  models: {
    claude: [
      { id: "opus", label: "Opus" },
      { id: "sonnet", label: "Sonnet" },
    ],
    codex: [{ id: "gpt-5.6", label: "GPT-5.6" }],
  },
};

// Launch responses are queued per test; the catalog is always served so the
// mount-time fetch cannot swallow a queued launch result.
const launchQueue: Array<() => Promise<unknown>> = [];

function queueLaunch(responder: () => Promise<unknown>): void {
  launchQueue.push(responder);
}

function queueLaunchedAgent(id: string): void {
  queueLaunch(() => Promise.resolve({ agent: makeAgent(id) }));
}

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  apiMock.mockReset();
  launchQueue.length = 0;
  apiMock.mockImplementation(((path: string) => {
    if (path === "/api/v1/agent-models") return Promise.resolve(MODEL_CATALOG);
    const responder = launchQueue.shift();
    if (!responder) throw new Error(`unexpected api call: ${path}`);
    return responder();
  }) as unknown as typeof api);
  toastErrorMock.mockReset();
  URL.createObjectURL = vi.fn(
    (input: File | Blob | MediaSource) =>
      `blob:${input instanceof File ? input.name : "blob"}`
  ) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
  // cmdk scrolls the selected option into view and observes the list's size;
  // jsdom provides neither API.
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

afterEach(() => {
  cleanup();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

describe("launch payload", () => {
  it("launches a no-arg template as JSON carrying the agent type and model", async () => {
    queueLaunchedAgent("agt_new");
    await renderDialog(makeTemplate());

    fireEvent.click(launchButton());

    await waitFor(() => expect(launchCalls()).toHaveLength(1));
    const body = lastJsonBody();
    expect(body).toEqual({ agentType: "claude", model: null });
    expect("args" in body).toBe(false);
    expect("startupFiles" in body).toBe(false);
    expect("startupLinks" in body).toBe(false);
  });

  it("sends typed args keyed by lowercased name, omitting untouched ones", async () => {
    queueLaunchedAgent("agt_new");
    await renderDialog(
      makeTemplate({ prompt: "Review {{D:Branch|required}} with {{D:Note}}" })
    );

    fireEvent.change(screen.getByLabelText(/Branch/), {
      target: { value: "main" },
    });
    fireEvent.click(launchButton());

    await waitFor(() => expect(launchCalls()).toHaveLength(1));
    expect(lastJsonBody()).toEqual({
      args: { branch: "main" },
      agentType: "claude",
      model: null,
    });
  });

  it("selecting a different agent type overrides the template default", async () => {
    queueLaunchedAgent("agt_new");
    await renderDialog(makeTemplate());

    fireEvent.click(agentTypeSelect());
    const codex = await screen.findByRole("option", { name: /Codex/ });
    fireEvent.click(codex);
    fireEvent.click(launchButton());

    await waitFor(() => expect(launchCalls()).toHaveLength(1));
    expect(lastJsonBody()).toEqual({ agentType: "codex", model: null });
  });
});

describe("model override", () => {
  it("defaults to the template's saved model and sends it unchanged", async () => {
    queueLaunchedAgent("agt_new");
    await renderDialog(makeTemplate({ model: "sonnet" }));

    expect(modelSelect().textContent).toContain("Sonnet");

    fireEvent.click(launchButton());

    await waitFor(() => expect(launchCalls()).toHaveLength(1));
    expect(lastJsonBody()).toEqual({ agentType: "claude", model: "sonnet" });
  });

  it("sends the picked model instead of the template's", async () => {
    queueLaunchedAgent("agt_new");
    await renderDialog(makeTemplate({ model: "sonnet" }));

    await pickModel(/Opus/);
    fireEvent.click(launchButton());

    await waitFor(() => expect(launchCalls()).toHaveLength(1));
    expect(lastJsonBody()).toEqual({ agentType: "claude", model: "opus" });
  });

  it("sends null when the saved model is cleared back to the CLI default", async () => {
    queueLaunchedAgent("agt_new");
    await renderDialog(makeTemplate({ model: "sonnet" }));

    await pickModel(/^Default/);
    fireEvent.click(launchButton());

    await waitFor(() => expect(launchCalls()).toHaveLength(1));
    expect(lastJsonBody()).toEqual({ agentType: "claude", model: null });
  });

  it("drops a model that the newly selected agent type cannot run", async () => {
    queueLaunchedAgent("agt_new");
    await renderDialog(makeTemplate({ model: "sonnet" }));

    fireEvent.click(agentTypeSelect());
    fireEvent.click(await screen.findByRole("option", { name: /Codex/ }));
    await waitFor(() => expect(modelSelect().textContent).toContain("Default"));

    fireEvent.click(launchButton());

    await waitFor(() => expect(launchCalls()).toHaveLength(1));
    expect(lastJsonBody()).toEqual({ agentType: "codex", model: null });
  });

  it("restores the template's model when switching back to its agent type", async () => {
    await renderDialog(makeTemplate({ model: "sonnet" }));

    fireEvent.click(agentTypeSelect());
    fireEvent.click(await screen.findByRole("option", { name: /Codex/ }));
    await waitFor(() => expect(modelSelect().textContent).toContain("Default"));

    fireEvent.click(agentTypeSelect());
    fireEvent.click(await screen.findByRole("option", { name: /Claude/ }));
    await waitFor(() => expect(modelSelect().textContent).toContain("Sonnet"));
  });

  it("keeps each runtime's own pick across agent type round trips", async () => {
    queueLaunchedAgent("agt_new");
    await renderDialog(makeTemplate({ model: "sonnet" }));

    await pickModel(/Opus/);

    fireEvent.click(agentTypeSelect());
    fireEvent.click(await screen.findByRole("option", { name: /Codex/ }));
    await waitFor(() => expect(modelSelect().textContent).toContain("Default"));
    await pickModel(/GPT-5\.6/);

    // Returning to Claude must restore the explicit Opus pick, not the
    // template's saved Sonnet.
    fireEvent.click(agentTypeSelect());
    fireEvent.click(await screen.findByRole("option", { name: /Claude/ }));
    await waitFor(() => expect(modelSelect().textContent).toContain("Opus"));

    // ...and Codex must still remember its own pick too.
    fireEvent.click(agentTypeSelect());
    fireEvent.click(await screen.findByRole("option", { name: /Codex/ }));
    await waitFor(() => expect(modelSelect().textContent).toContain("GPT-5.6"));

    fireEvent.click(launchButton());

    await waitFor(() => expect(launchCalls()).toHaveLength(1));
    expect(lastJsonBody()).toEqual({ agentType: "codex", model: "gpt-5.6" });
  });
});

describe("arg gating", () => {
  it("disables launch until every required arg is non-blank", async () => {
    await renderDialog(makeTemplate({ prompt: "Do {{D:Task|required}}" }));

    expect(launchButton().disabled).toBe(true);

    // Whitespace must not satisfy a required arg.
    fireEvent.change(screen.getByLabelText(/Task/), {
      target: { value: "   " },
    });
    expect(launchButton().disabled).toBe(true);

    // Enter-key submission bypasses the disabled button, so the submit
    // handler must gate on filled args too. A broken gate only reaches the
    // api seam on a later microtask — flush before asserting.
    fireEvent.submit(dialogForm());
    await act(async () => {});
    expect(launchCalls()).toHaveLength(0);

    fireEvent.change(screen.getByLabelText(/Task/), {
      target: { value: "ship it" },
    });
    expect(launchButton().disabled).toBe(false);
  });

  it("optional args do not block launching", async () => {
    await renderDialog(makeTemplate({ prompt: "Maybe {{D:Note}}" }));
    expect(launchButton().disabled).toBe(false);
  });
});

describe("launch outcome", () => {
  it("closes the dialog and navigates to the new agent on success", async () => {
    queueLaunchedAgent("agt_new");
    const { onOpenChange } = await renderDialog(makeTemplate());

    fireEvent.click(launchButton());

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(screen.getByTestId("location").textContent).toBe("/agents/agt_new");
  });

  it("surfaces a toast and stays open on failure", async () => {
    queueLaunch(() => Promise.reject(new Error("boom")));
    const { onOpenChange } = await renderDialog(makeTemplate());

    fireEvent.click(launchButton());

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("Failed to launch: boom")
    );
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("location").textContent).toBe("/");
  });

  it("ignores resubmits while a launch is pending", async () => {
    let resolveLaunch!: (value: { agent: Agent }) => void;
    queueLaunch(
      () =>
        new Promise((resolve) => {
          resolveLaunch = resolve;
        })
    );
    const { onOpenChange } = await renderDialog(makeTemplate());

    fireEvent.click(launchButton());
    await waitFor(() => expect(launchButton().disabled).toBe(true));

    // A second submit while pending must not fire a duplicate launch. The
    // duplicate mutation would only reach the api seam asynchronously, so
    // settle everything before asserting the final call count.
    fireEvent.submit(dialogForm());

    resolveLaunch({ agent: makeAgent("agt_new") });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(launchCalls()).toHaveLength(1);
  });
});

describe("terminal templates", () => {
  it("hides agent type and media affordances and launches as terminal", async () => {
    queueLaunchedAgent("agt_new");
    await renderDialog(
      makeTemplate({ agentType: "terminal", allowMedia: true })
    );

    expect(
      screen.getByText("This will open a terminal session in /repo.")
    ).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByTestId("launch-template-model")).toBeNull();
    // allowMedia is true, but terminal launches have nowhere to route media.
    expect(screen.queryByText("Add files or links")).toBeNull();

    fireEvent.click(launchButton());

    await waitFor(() => expect(launchCalls()).toHaveLength(1));
    expect(lastJsonBody()).toEqual({ agentType: "terminal" });
  });
});

describe("media attachments", () => {
  it("ignores drops when the template does not allow media", async () => {
    queueLaunchedAgent("agt_new");
    await renderDialog(makeTemplate({ allowMedia: false }));

    expect(screen.queryByText("Add files or links")).toBeNull();
    dropFiles(dialogForm(), [file("shot.png", "image/png")]);
    expect(screen.queryByText("shot.png")).toBeNull();

    fireEvent.click(launchButton());

    await waitFor(() => expect(launchCalls()).toHaveLength(1));
    // Still the plain JSON branch — nothing was attached.
    expect(lastJsonBody()).toEqual({ agentType: "claude", model: null });
  });

  it("arms the drop zone only for file drags", async () => {
    await renderDialog(makeTemplate({ allowMedia: true }));

    // Positive control for the empty-state copy the media-gating tests
    // assert absent — if this copy drifts, those absence checks go vacuous.
    expect(screen.getByText("Add files or links")).toBeTruthy();

    fireEvent.dragOver(dialogForm(), {
      dataTransfer: { types: ["text/plain"], files: [] },
    });
    expect(screen.queryByText("Drop file to add")).toBeNull();

    fireEvent.dragOver(dialogForm(), {
      dataTransfer: { types: ["Files"], files: [] },
    });
    expect(screen.getByText("Drop file to add")).toBeTruthy();
  });

  it("sends dropped files, added links, and args as multipart form data", async () => {
    queueLaunchedAgent("agt_new");
    await renderDialog(
      makeTemplate({
        allowMedia: true,
        model: "sonnet",
        prompt: "Ship {{D:Tag|required}}",
      })
    );
    fireEvent.change(screen.getByLabelText(/Tag/), {
      target: { value: "v1" },
    });

    const shot = file("shot.png", "image/png");
    const notes = file("notes.txt", "text/plain");
    dropFiles(dialogForm(), [shot, notes]);
    // Re-dropping the same file must not attach a duplicate.
    dropFiles(dialogForm(), [file("shot.png", "image/png")]);

    expect(screen.getByText("shot.png")).toBeTruthy();
    expect(screen.getByText("notes.txt")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Add context"));
    fireEvent.click(await screen.findByRole("button", { name: "Add link" }));
    fireEvent.change(screen.getByPlaceholderText("https://..."), {
      target: { value: "https://example.com/docs" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    expect(screen.getByText(/example\.com/)).toBeTruthy();

    fireEvent.click(launchButton());

    await waitFor(() => expect(launchCalls()).toHaveLength(1));
    const body = lastCallBody();
    expect(body).toBeInstanceOf(FormData);
    const formData = body as FormData;
    expect(
      formData.getAll("startupFiles").map((f) => (f as File).name)
    ).toEqual(["shot.png", "notes.txt"]);
    expect(formData.get("startupLinks")).toBe(
      JSON.stringify(["https://example.com/docs"])
    );
    expect(formData.get("agentType")).toBe("claude");
    expect(formData.get("model")).toBe("sonnet");
    expect(formData.get("args")).toBe(JSON.stringify({ tag: "v1" }));
  });

  it("sends an empty model field when multipart launches use the CLI default", async () => {
    queueLaunchedAgent("agt_new");
    await renderDialog(makeTemplate({ allowMedia: true }));

    dropFiles(dialogForm(), [file("shot.png", "image/png")]);
    fireEvent.click(launchButton());

    await waitFor(() => expect(launchCalls()).toHaveLength(1));
    const formData = lastCallBody() as FormData;
    // Absent would mean "keep the template's model"; empty means "default".
    expect(formData.get("model")).toBe("");
  });

  it("keeps a removed file out of the payload", async () => {
    queueLaunchedAgent("agt_new");
    await renderDialog(makeTemplate({ allowMedia: true }));

    dropFiles(dialogForm(), [
      file("shot.png", "image/png"),
      file("notes.txt", "text/plain"),
    ]);
    fireEvent.click(screen.getByLabelText("Remove shot.png"));
    expect(screen.queryByText("shot.png")).toBeNull();

    fireEvent.click(launchButton());

    await waitFor(() => expect(launchCalls()).toHaveLength(1));
    const body = lastCallBody();
    expect(body).toBeInstanceOf(FormData);
    expect(
      (body as FormData).getAll("startupFiles").map((f) => (f as File).name)
    ).toEqual(["notes.txt"]);
    // No links and no prompt args here — those fields must be absent, not
    // serialized empties.
    expect((body as FormData).get("startupLinks")).toBeNull();
    expect((body as FormData).get("args")).toBeNull();
  });
});
