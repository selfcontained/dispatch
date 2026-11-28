// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { EngineScope } from "@dispatch/runner-protocol/engine-management";
import { EngineSignInSettings } from "@/components/app/engine-sign-in-settings";
import { EngineUpdatesCard } from "@/components/app/engine-updates-card";
import { PluginUpdateSettings } from "@/components/app/plugin-update-settings";
import { RunnerEngines } from "@/components/runner-engines/runner-engines";
import { PlanLimits, useNow } from "@/components/runner-engines/provider-usage";
import { useProviderPlans } from "./use-agent-usage";
import { api } from "@/lib/api";
vi.mock("@/lib/api", async () => ({
  ...(await vi.importActual("@/lib/api")),
  api: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
});
const scopes: EngineScope[] = [
  { kind: "local" },
  { kind: "runner", runnerId: "r1" },
];
const plugin = {
  agentType: "claude",
  installed: true,
  enabled: true,
  currentVersion: "1",
  latestVersion: "2",
  updateAvailable: true,
};
function Usage({ scope }: { scope: EngineScope }) {
  const plans = useProviderPlans(true, scope);
  return <PlanLimits enabled plans={plans} now={useNow(true)} scope={scope} />;
}
it.each(scopes)("keeps settings actions on the $kind scope", async (scope) => {
  const operations: Record<string, unknown>[] = [];
  let login: object | null = null;
  const usage = {
    checkedAt: new Date().toISOString(),
    providers: [{ engine: "claude", plan: "Pro", windows: [] }],
  };
  vi.mocked(api).mockImplementation(async (url, init) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      expect(body.scope).toEqual(scope);
      operations.push(body.operation);
      switch (body.operation.type) {
        case "provider_usage":
          return {
            ack: { ok: true, capability: { type: "provider_usage", usage } },
          };
        case "plugin_update":
          return {
            ack: {
              ok: true,
              capability: {
                type: "plugin_status",
                status: { ...plugin, updateAvailable: false },
              },
            },
          };
        case "login_start":
          login = {
            id: "login",
            engine: "claude",
            status: "waiting",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            url: "https://example.test/login",
            needsCode: true,
          };
          break;
        case "update":
          return { ack: { ok: true, operationId: "update" } };
      }
      return { ack: { ok: true, ...(login ? { login } : {}) } };
    }
    const parsed = new URL(url, "http://localhost");
    expect(parsed.pathname.startsWith("/api/v1/engine-management/")).toBe(true);
    expect(parsed.searchParams.get("scope")).toBe(scope.kind);
    expect(parsed.searchParams.get("runnerId")).toBe(
      scope.kind === "runner" ? scope.runnerId : null
    );
    if (parsed.pathname.endsWith("/auth"))
      return {
        engines: [{ engine: "claude", installed: true, signedIn: false }],
      };
    if (parsed.pathname.endsWith("/plugins")) return { statuses: [plugin] };
    if (parsed.pathname.endsWith("/status"))
      return {
        canManage: true,
        engines: [
          {
            id: "claude",
            label: "Claude Code",
            installed: true,
            path: "/bin/claude",
            version: "1",
            update: {
              canUpdate: true,
              available: true,
              latestVersion: "2",
              command: "claude update",
            },
          },
        ],
      };
    throw new Error(url);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <EngineSignInSettings scope={scope} />
      <EngineUpdatesCard scope={scope} />
      <PluginUpdateSettings scope={scope} />
      <Usage scope={scope} />
    </QueryClientProvider>
  );
  const signIn = await screen.findByTestId("engine-sign-in-start");
  await waitFor(() => expect(signIn).toHaveProperty("disabled", false));
  fireEvent.click(signIn);
  expect(await screen.findByTestId("engine-sign-in-code")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: /Claude Code1Update available/ })
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Update Claude Code to 2" })
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Update Claude Code plugin" })
  );
  fireEvent.click(screen.getByTestId("usage-plans-refresh"));
  await waitFor(() =>
    expect(operations).toEqual(
      expect.arrayContaining([
        { type: "update", engine: "claude" },
        {
          type: "plugin_update",
          engine: "claude",
          plugin: "dispatch@dispatch",
        },
        { type: "provider_usage", force: true },
      ])
    )
  );
});
it.each(scopes)(
  "offers the same plugin and sign-in rows on the $kind runner page",
  async (scope) => {
    vi.mocked(api).mockImplementation(async (url, init) => {
      if (init?.method === "POST") return { ack: { ok: true } };
      const parsed = new URL(url, "http://localhost");
      expect(parsed.searchParams.get("scope")).toBe(scope.kind);
      if (parsed.pathname.endsWith("/inventory"))
        return {
          entries: [
            {
              id: "claude",
              label: "Claude Code",
              installed: true,
              signedIn: false,
              actions: ["login"],
            },
          ],
        };
      if (parsed.pathname.endsWith("/plugins")) return { statuses: [plugin] };
      throw new Error(url);
    });
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <RunnerEngines scope={scope} capabilities />
      </QueryClientProvider>
    );
    const row = await screen.findByTestId("runner-engine-claude");
    expect(
      await within(row).findByRole("button", { name: "Update plugin" })
    ).toBeTruthy();
    const start = within(row).getByRole("button", { name: "Sign in" });
    await waitFor(() => expect(start).toHaveProperty("disabled", false));
    fireEvent.click(start);
    await waitFor(() =>
      expect(
        vi
          .mocked(api)
          .mock.calls.some(
            ([, init]) =>
              init?.body &&
              JSON.parse(String(init.body)).operation.type === "login_start"
          )
      ).toBe(true)
    );
    for (const [, init] of vi
      .mocked(api)
      .mock.calls.filter(([, init]) => init?.method === "POST"))
      expect(JSON.parse(String(init!.body)).scope).toEqual(scope);
  }
);
