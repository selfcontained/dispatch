// @vitest-environment jsdom
import { getDefaultStore } from "jotai";
import { dismissedAttentionAtom } from "@/lib/store";
import { api } from "@/lib/api";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AttentionCard } from "./attention-toast";
import { NotificationsDrawer } from "./notifications-drawer";
import type { AttentionHistoryItem } from "@dispatch/shared";
const items: AttentionHistoryItem[] = (
  ["question", "form", "approval", "blocked"] as const
).map((kind, i) => ({
  type: "attention.toast",
  toastId: String(i),
  agentId: "agent",
  agentName: "Builder",
  kind,
  message: `${kind} message`,
  target: { streamId: "agent", threadId: null, blockId: `block-${i}` },
  createdAt: new Date().toISOString(),
  settled: i === 1,
}));
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
beforeEach(() => {
  getDefaultStore().set(dismissedAttentionAtom, {});
  window.localStorage.clear();
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue(items);
});
afterEach(cleanup);
it.each(items)(
  "shares toast rendering for $kind and adds time and settled styling",
  (item) => {
    const { container } = render(
      <MemoryRouter>
        <AttentionCard event={item} onOpen={() => {}} onDismiss={() => {}} />
        <AttentionCard
          event={item}
          onOpen={() => {}}
          createdAt={item.createdAt}
          settled={item.settled}
          link
        />
      </MemoryRouter>
    );
    const cards = container.querySelectorAll("[data-kind]");
    expect(cards[0].innerHTML.replace(/class="[^"]*"/g, "")).toContain(
      item.message
    );
    expect(cards[1].textContent).toContain(item.message);
    expect(cards[0].querySelector("svg")?.outerHTML).toBe(
      cards[1].querySelector("svg")?.outerHTML
    );
    expect(cards[1].querySelector("time")).not.toBeNull();
    if (item.settled)
      expect(cards[1].parentElement?.className).toContain("opacity-50");
  }
);
it("opens a message link and closes the drawer", async () => {
  function Location() {
    const l = useLocation();
    return <output>{l.pathname + l.search}</output>;
  }
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <NotificationsDrawer />
        <Location />
      </MemoryRouter>
    </QueryClientProvider>
  );
  fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
  fireEvent.click(
    await screen.findByRole("link", { name: /question message/ })
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("status").textContent).toBe(
    "/agents/agent?block=block-0"
  );
  fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
  expect(screen.queryByRole("link", { name: /question message/ })).toBeNull();
  expect(screen.getAllByRole("link")).toHaveLength(3);
  expect(getDefaultStore().get(dismissedAttentionAtom)).toHaveProperty("0");
});

it("keeps cached cards visible after a failed background refresh", async () => {
  vi.mocked(api).mockRejectedValue(new Error("offline"));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["attention-history"], items);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <NotificationsDrawer />
      </MemoryRouter>
    </QueryClientProvider>
  );
  fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
  await waitFor(() =>
    expect(client.getQueryState(["attention-history"])?.status).toBe("error")
  );
  expect(screen.getAllByRole("link")).toHaveLength(4);
  expect(screen.queryByRole("alert")).toBeNull();
});
it("offers retry when there are no cached notifications", async () => {
  vi.mocked(api).mockRejectedValue(new Error("offline"));
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <NotificationsDrawer />
      </MemoryRouter>
    </QueryClientProvider>
  );
  fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn’t load notifications"
  );
  vi.mocked(api).mockResolvedValue(items);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("link", { name: /question message/ })
  ).toBeTruthy();
});

it.each([
  { ctrlKey: true },
  { metaKey: true },
  { shiftKey: true },
  { button: 1 },
])(
  "preserves the drawer and item for modified activation %j",
  async (modifiers) => {
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter>
          <NotificationsDrawer />
        </MemoryRouter>
      </QueryClientProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    const link = await screen.findByRole("link", { name: /question message/ });
    fireEvent.click(link, modifiers);
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /question message/ })).toBeTruthy();
    expect(getDefaultStore().get(dismissedAttentionAtom)).toEqual({});
  }
);
