// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { BackgroundSnapshot } from "@dispatch/shared";
import { api } from "@/lib/api";
import { BackgroundWorkButton } from "./background-work-button";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const key = ["background-work", "agent-one"];
function setup(snapshot?: BackgroundSnapshot) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (snapshot) client.setQueryData(key, snapshot);
  render(
    <QueryClientProvider client={client}>
      <BackgroundWorkButton agentId="agent-one" />
    </QueryClientProvider>
  );
  return client;
}

it("discovers work while hidden, shows an icon-only trigger, and removes it when work ends", async () => {
  vi.mocked(api).mockResolvedValue({ status: "supported", items: [] });
  const client = setup();
  expect(screen.queryByRole("button")).toBeNull();
  await waitFor(() =>
    expect(client.getQueryState(key)?.fetchStatus).toBe("idle")
  );
  expect(screen.queryByRole("button")).toBeNull();

  act(() => {
    client.setQueryData(key, {
      status: "supported",
      items: [
        { id: "command", name: "Watch build", kind: "shell", state: "running" },
      ],
    });
  });
  const trigger = await screen.findByRole("button", {
    name: "Background work 1",
  });
  expect(trigger.textContent).toBe("");
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "Background work" })).toBeTruthy();
  expect(screen.getByText("Watch build")).toBeTruthy();

  act(() => {
    client.setQueryData(key, { status: "supported", items: [] });
  });
  await screen.findByText("No reported background work.");
  expect(
    screen.queryByRole("button", { name: "Background work 1" })
  ).toBeNull();
  expect(screen.getByText("No reported background work.")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Close background work" })
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
});

it.each(["unsupported", "offline", "unavailable"] as const)(
  "hides the trigger when visibility is %s",
  (status) => {
    setup({ status, items: [] });
    expect(screen.queryByRole("button")).toBeNull();
  }
);
