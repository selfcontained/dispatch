// @vitest-environment jsdom
import type { ComponentProps } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Block, RoutingDiagnostic } from "@dispatch/shared";
import { api } from "@/lib/api";
import { block } from "@/test-utils/blocks";
import { MessageActions } from "./message-actions";
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
const apiMock = vi.mocked(api);
let client: QueryClient;
const diagnostic: RoutingDiagnostic = {
  turnId: 1,
  agentId: "a",
  mode: "active",
  status: "ok",
  actual: "Root",
  choice: "home_root",
  reason: "Recommendation applied",
  probabilities: [{ value: "home_root", probability: 0.9 }],
  confidence: 0.9,
  costUsd: null,
  costBasis: "unknown",
};
const user = () =>
  block({
    id: "opener",
    streamId: "stream",
    author: { kind: "user" },
    toAgentId: "a",
    delivered: true,
  });
const names = (id: string) =>
  ({ a: "Alpha", b: "Beta", c: "Gamma", d: "Delta", e: "Epsilon" })[
    id as "a"
  ] ?? id;
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  apiMock.mockReset().mockResolvedValue({ routing: [diagnostic] });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  client.clear();
});
function show(
  post: Block = user(),
  props: Partial<ComponentProps<typeof MessageActions>> = {}
) {
  const reply = vi.fn(),
    react = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <MessageActions
        block={post}
        copy={<button>Copy message</button>}
        senderName="You"
        agentName={names}
        onReply={reply}
        onReact={react}
        reactionsDisabled={false}
        {...props}
      />
    </QueryClientProvider>
  );
  return { ...view, reply, react };
}
async function menu() {
  fireEvent.keyDown(screen.getByRole("button", { name: "Message actions" }), {
    key: "ArrowDown",
  });
  await screen.findByRole("menuitem", { name: "Message metadata" });
}
async function metadata() {
  await menu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Message metadata" }));
  return screen.findByRole("dialog", { name: "Message metadata" });
}
it("loads routing only when user-message metadata opens, caches fresh reopen and refreshes an invalidated reopen", async () => {
  let finish!: (value: unknown) => void;
  apiMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  show();
  expect(apiMock).not.toHaveBeenCalled();
  expect(
    client.getQueryCache().findAll({ queryKey: ["message-metadata"] })
  ).toHaveLength(0);
  expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
    "Copy message",
    "",
  ]);
  await menu();
  expect(apiMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("menuitem", { name: "Message metadata" }));
  await screen.findByText("Loading routing details…");
  expect(apiMock.mock.calls[0][0]).toBe(
    "/api/v1/streams/stream/blocks/opener/metadata"
  );
  await act(async () => {
    finish({ routing: [diagnostic] });
  });
  await screen.findByRole("region", { name: "Routing for Alpha" });
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Message metadata" }), {
    key: "Escape",
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await metadata();
  await screen.findByRole("region", { name: "Routing for Alpha" });
  expect(apiMock).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await act(async () => {
    await client.invalidateQueries({
      queryKey: ["message-metadata", "stream"],
    });
  });
  expect(apiMock).toHaveBeenCalledTimes(1);
  await metadata();
  await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
});
it("does not fetch or display routing on an agent response even if it carries transitional routing data", async () => {
  show({
    ...user(),
    author: { kind: "agent", agentId: "a" },
    routing: [diagnostic],
  });
  await metadata();
  expect(apiMock).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("region", { name: "Routing for Alpha" })
  ).toBeNull();
});
it("distinguishes pickup from sending, queued and failed delivery without inventing recipients", async () => {
  show({
    ...user(),
    delivery: [
      {
        agentId: "a",
        state: "delivered",
        receipt: {
          deliveredAt: "2026-11-08T12:00:00Z",
          pickedUpAt: "2026-11-08T12:00:01Z",
          mode: "steering",
        },
      },
      {
        agentId: "b",
        state: "delivered",
        receipt: { deliveredAt: "2026-11-08T12:00:00Z", pickedUpAt: null },
      },
      { agentId: "c", state: "held" },
      { agentId: "d", state: "failed" },
      { agentId: "e", state: "pending" },
    ],
  });
  const dialog = await metadata();
  for (const name of ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"])
    expect(within(dialog).getAllByText(name).length).toBeGreaterThan(0);
  expect(within(dialog).getByText("Received · steering")).toBeTruthy();
  expect(within(dialog).getByText("Sent · awaiting pickup")).toBeTruthy();
  expect(within(dialog).getByText("Queued")).toBeTruthy();
  expect(within(dialog).getByText("Failed")).toBeTruthy();
  expect(within(dialog).getByText("Sending")).toBeTruthy();
});
it("deduplicates legacy recipient arrays while leaving pickup unconfirmed", async () => {
  show({
    ...user(),
    kind: "text",
    state: null,
    delivery: undefined,
    data: { mentions: ["a", "b", "a"], recipients: ["b"] },
  });
  const dialog = await metadata();
  const delivery = within(dialog).getByRole("region", {
    name: "Message delivery",
  });
  expect(within(delivery).getAllByText("Alpha")).toHaveLength(1);
  expect(within(delivery).getAllByText("Beta")).toHaveLength(1);
  expect(
    within(delivery).getAllByText("Delivered · pickup unconfirmed")
  ).toHaveLength(2);
  expect(within(delivery).queryByText("Received")).toBeNull();
});
it("shows a demand-load error without inventing routing data", async () => {
  apiMock.mockRejectedValue(new Error("unavailable"));
  show();
  await metadata();
  await screen.findByText("Couldn’t load routing details.");
  expect(
    screen.queryByRole("region", { name: "Routing for Alpha" })
  ).toBeNull();
});
it.each(["user", "agent"] as const)(
  "opens a nonmodal anchored React picker on %s messages, independently of metadata",
  async (author) => {
    const { react } = show({
      ...user(),
      author:
        author === "user" ? { kind: "user" } : { kind: "agent", agentId: "a" },
    });
    await menu();
    fireEvent.click(screen.getByRole("menuitem", { name: "React" }));
    const picker = await screen.findByRole("dialog", {
      name: "React to message",
    });
    expect(picker.getAttribute("aria-modal")).not.toBe("true");
    expect(
      screen.queryByRole("heading", { name: "Message metadata" })
    ).toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
    fireEvent.click(
      within(picker).getByRole("button", { name: "React with 🎉" })
    );
    expect(react).toHaveBeenCalledWith("🎉", false);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  }
);
it("keeps Reply in thread in overflow without fetching metadata", async () => {
  const { reply } = show();
  expect(screen.queryByRole("button", { name: "Reply in thread" })).toBeNull();
  await menu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Reply in thread" }));
  expect(reply).toHaveBeenCalledOnce();
  expect(apiMock).not.toHaveBeenCalled();
});

it.each(["Message metadata", "React"])(
  "returns focus to the overflow trigger when %s closes with Escape",
  async (label) => {
    show();
    const trigger = screen.getByRole("button", { name: "Message actions" });
    trigger.focus();
    await menu();
    fireEvent.click(screen.getByRole("menuitem", { name: label }));
    const overlay = await screen.findByRole("dialog", {
      name: label === "React" ? "React to message" : "Message metadata",
    });
    await waitFor(() =>
      expect(overlay.contains(document.activeElement)).toBe(true)
    );
    fireEvent.keyDown(overlay, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  }
);

it("reports an unavailable system observation as not attempted in metadata", async () => {
  show(
    block({
      author: { kind: "system" },
      toAgentId: "a",
      delivered: false,
      delivery: [{ agentId: "a", state: "not_attempted" }],
    })
  );
  const dialog = await metadata();
  expect(
    within(dialog).getByText("Not attempted · agent unavailable")
  ).toBeTruthy();
  expect(
    within(dialog).queryByText("Delivered · pickup unconfirmed")
  ).toBeNull();
});
