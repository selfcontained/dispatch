// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
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
vi.mock("@/lib/api", () => ({ api: () => Promise.resolve(items) }));
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
});
