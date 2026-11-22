// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import type {
  EngineInventoryEntry,
  EngineOperationAck,
} from "@dispatch/runner-protocol/engine-management";

import { runnerEnginesKey } from "@/hooks/use-runner-engines";

import { RunnerEngines } from "./runner-engines";
import { RunnerProviderUsage } from "./runner-provider-usage";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const baseEntries: EngineInventoryEntry[] = [
  {
    id: "claude",
    label: "Claude Code",
    installed: true,
    signedIn: true,
    version: "1.2.3",
    detail: "me@example.com",
    actions: ["update", "login", "login_cancel"],
  },
  {
    id: "codex",
    label: "Codex",
    installed: false,
    signedIn: null,
    version: null,
    actions: ["install"],
  },
];

function renderWithClient(scope: Parameters<typeof RunnerEngines>[0]["scope"]) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <RunnerEngines scope={scope} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(api).mockReset();
});

afterEach(cleanup);

it("renders each engine's installed/signed-in state and available actions", async () => {
  vi.mocked(api).mockResolvedValue({ entries: baseEntries });
  renderWithClient({ kind: "local" });

  await waitFor(() => screen.getByTestId("runner-engine-claude"));
  expect(screen.getByTestId("runner-engine-claude").textContent).toContain(
    "v1.2.3"
  );
  expect(screen.getByTestId("runner-engine-claude").textContent).toContain(
    "signed in"
  );
  expect(screen.queryByTestId("runner-engine-claude-install")).toBeNull();
  expect(screen.getByTestId("runner-engine-claude-update")).toBeTruthy();

  expect(screen.getByTestId("runner-engine-codex").textContent).toContain(
    "Not installed"
  );
  expect(screen.getByTestId("runner-engine-codex-install")).toBeTruthy();
});

it.each([true, false])(
  "shows the unknown inventory state with updating=%s",
  async (updating) => {
    vi.mocked(api).mockResolvedValue({ entries: null });
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <RunnerEngines
          scope={{ kind: "runner", runnerId: "r1" }}
          updating={updating}
        />
        <RunnerProviderUsage runnerId="r1" />
      </QueryClientProvider>
    );
    await waitFor(() =>
      expect(
        client.getQueryData(
          runnerEnginesKey({ kind: "runner", runnerId: "r1" })
        )
      ).toEqual({ entries: null })
    );
    const shown = updating ? "Loading engines…" : "No engines reported.";
    const hidden = updating ? "No engines reported." : "Loading engines…";
    expect(await screen.findByText(shown)).toBeTruthy();
    expect(screen.queryByText(hidden)).toBeNull();
    expect(screen.queryByText("Set up Claude or Codex")).toBeNull();
  }
);

it("shows a failed read over unknown engines", async () => {
  vi.mocked(api).mockRejectedValue(new Error("down"));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const scope = { kind: "runner", runnerId: "r1" } as const;
  client.setQueryData(runnerEnginesKey(scope), { entries: null });
  render(
    <QueryClientProvider client={client}>
      <RunnerEngines scope={scope} />
    </QueryClientProvider>
  );
  expect(await screen.findByText("Could not load engines.")).toBeTruthy();
});

it("posts an install operation scoped to a runner and refreshes", async () => {
  const ack: EngineOperationAck = { ok: true, operationId: "op-1" };
  vi.mocked(api).mockImplementation(
    async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        expect(JSON.parse(init.body as string)).toMatchObject({
          scope: { kind: "runner", runnerId: "r1" },
          operation: { type: "install", engine: "codex" },
        });
        return { ack };
      }
      expect(path).toContain("scope=runner");
      expect(path).toContain("runnerId=r1");
      return { entries: baseEntries };
    }
  );

  renderWithClient({ kind: "runner", runnerId: "r1" });
  await waitFor(() => screen.getByTestId("runner-engine-codex-install"));
  fireEvent.click(screen.getByTestId("runner-engine-codex-install"));

  await waitFor(() =>
    expect(
      vi.mocked(api).mock.calls.filter(([, init]) => init?.method === "POST")
    ).toHaveLength(1)
  );
});

it("walks a Codex-style device sign-in to the waiting state", async () => {
  vi.mocked(api).mockImplementation(
    async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const ack: EngineOperationAck = {
          ok: true,
          login: {
            id: "login-1",
            engine: "claude",
            status: "waiting",
            needsCode: false,
            url: "https://auth.example.com/device",
            userCode: "ABCD-1234",
            expiresAt: new Date().toISOString(),
          },
        };
        return { ack };
      }
      return { entries: [{ ...baseEntries[0]!, signedIn: false }] };
    }
  );

  renderWithClient({ kind: "local" });
  await waitFor(() => screen.getByTestId("runner-engine-claude-sign-in"));
  fireEvent.click(screen.getByTestId("runner-engine-claude-sign-in"));

  await waitFor(() => expect(screen.getByText("ABCD-1234")).toBeTruthy());
  expect(
    screen.getByDisplayValue("https://auth.example.com/device")
  ).toBeTruthy();
});

it("surfaces a failed update instead of silently reporting success", async () => {
  const ack: EngineOperationAck = {
    ok: false,
    error: "Update command failed (exit code 1).",
  };
  vi.mocked(api).mockImplementation(
    async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") return { ack };
      return { entries: baseEntries };
    }
  );

  renderWithClient({ kind: "local" });
  await waitFor(() => screen.getByTestId("runner-engine-claude-update"));
  fireEvent.click(screen.getByTestId("runner-engine-claude-update"));

  await waitFor(() =>
    expect(
      screen.getByTestId("runner-engine-claude-action-error").textContent
    ).toContain("exit code 1")
  );
});

it("shows an up-to-date update as a success message, not a failure", async () => {
  const ack: EngineOperationAck = {
    ok: true,
    message: "Already up to date (version 1.2.3).",
  };
  vi.mocked(api).mockImplementation(
    async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") return { ack };
      return { entries: baseEntries };
    }
  );

  renderWithClient({ kind: "local" });
  await waitFor(() => screen.getByTestId("runner-engine-claude-update"));
  fireEvent.click(screen.getByTestId("runner-engine-claude-update"));

  await waitFor(() =>
    expect(
      screen.getByTestId("runner-engine-claude-action-success").textContent
    ).toContain("Already up to date")
  );
  expect(screen.queryByTestId("runner-engine-claude-action-error")).toBeNull();
});

it("polls login status and reflects a device sign-in settling on its own", async () => {
  let loginPolls = 0;
  vi.mocked(api).mockImplementation(
    async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        if (body.operation.type === "login_start") {
          return {
            ack: {
              ok: true,
              login: {
                id: "login-1",
                engine: "claude",
                status: "waiting",
                needsCode: false,
                url: "https://auth.example.com/device",
                userCode: "ABCD-1234",
                expiresAt: new Date().toISOString(),
              },
            },
          };
        }
        // login_status: settle to "succeeded" on the second poll, the
        // way a self-driven device flow finishes without the user
        // submitting anything.
        loginPolls += 1;
        const settled = loginPolls >= 2;
        return {
          ack: {
            ok: true,
            login: {
              id: "login-1",
              engine: "claude",
              status: settled ? "succeeded" : "waiting",
              needsCode: false,
              ...(settled ? { detail: "me@example.com" } : {}),
              expiresAt: new Date().toISOString(),
            },
          },
        };
      }
      return { entries: [{ ...baseEntries[0]!, signedIn: false }] };
    }
  );

  renderWithClient({ kind: "local" });
  await waitFor(() => screen.getByTestId("runner-engine-claude-sign-in"));
  fireEvent.click(screen.getByTestId("runner-engine-claude-sign-in"));

  await waitFor(() => expect(screen.getByText("ABCD-1234")).toBeTruthy());
  await waitFor(
    () =>
      expect(screen.getByText(/Signed in/).textContent).toContain(
        "me@example.com"
      ),
    { timeout: 5_000 }
  );
});
