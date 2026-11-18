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

import { RunnerEngines } from "./runner-engines";

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
    "not installed"
  );
  expect(screen.getByTestId("runner-engine-codex-install")).toBeTruthy();
});

it("posts an install operation scoped to a runner workspace and refreshes", async () => {
  const ack: EngineOperationAck = { ok: true, operationId: "op-1" };
  vi.mocked(api).mockImplementation(
    async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        expect(JSON.parse(init.body as string)).toMatchObject({
          scope: { kind: "runner", runnerId: "r1", workspace: "w1" },
          operation: { type: "install", engine: "codex" },
        });
        return { ack };
      }
      expect(path).toContain("scope=runner");
      expect(path).toContain("runnerId=r1");
      expect(path).toContain("workspace=w1");
      return { entries: baseEntries };
    }
  );

  renderWithClient({ kind: "runner", runnerId: "r1", workspace: "w1" });
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
  expect(screen.getByText("https://auth.example.com/device")).toBeTruthy();
});
