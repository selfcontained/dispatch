// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ListBlock } from "../types";
import { ListBlockView } from "./list-block";

const mutate = vi.fn();
vi.mock("@/hooks/use-agent-surfaces", () => ({
  makeIdempotencyKey: () => "idem-test",
  useSubmitSurfaceInteraction: () => ({ mutate }),
}));

afterEach(() => {
  cleanup();
  mutate.mockReset();
});

function renderList(block: ListBlock) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ListBlockView
        block={block}
        agentId="agt_test"
        surfaceId="surface_test"
        surfaceRevision={1}
        interactions={new Map()}
        onRequestRefresh={async () => {}}
        readOnly={false}
        idPrefix="test"
      />
    </QueryClientProvider>
  );
}

describe("ListBlockView v2", () => {
  it("renders explicit checked and unchecked boxes without inferring from tone", () => {
    renderList({
      id: "work",
      type: "list",
      style: "check",
      items: [
        {
          id: "done",
          text: "Done",
          status: "Complete",
          tone: "success",
          checked: true,
        },
        {
          id: "pending",
          text: "Pending",
          status: "Waiting",
          tone: "warning",
        },
      ],
    });

    expect(
      document.querySelectorAll('[data-check-state="checked"]')
    ).toHaveLength(1);
    expect(
      document.querySelectorAll('[data-check-state="unchecked"]')
    ).toHaveLength(1);
    expect(screen.getByRole("img", { name: "Completed" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Not completed" })).toBeTruthy();
  });

  it("renders count, grouped items, a toned freeform status, and a safe link", () => {
    renderList({
      id: "work",
      type: "list",
      title: "Work",
      showItemCount: true,
      items: [
        {
          id: "one",
          text: "Review",
          group: "Now",
          status: "Needs input",
          tone: "warning",
          url: "https://example.com",
        },
        { id: "two", text: "Ship", group: "Later" },
      ],
    });
    expect(screen.getByRole("heading", { name: "Work" })).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("Now").closest("li")).toBeTruthy();
    expect(screen.getByText("Needs input").className).toContain(
      "text-status-waiting"
    );
    expect(
      screen.getByRole("link", { name: "Open Review" }).getAttribute("href")
    ).toBe("https://example.com");
    expect(
      screen.getByRole("link", { name: "Open Review" }).className
    ).toContain("[@media(pointer:coarse)]:h-11");
  });

  it("wraps long status and action affordances below the item content", () => {
    renderList({
      id: "work",
      type: "list",
      items: [
        {
          id: "one",
          text: "Review the release",
          status:
            "Waiting for a particularly detailed cross-functional approval",
          tone: "warning",
          action: {
            id: "request",
            label: "Request approval from the release coordination team",
            intent: "request_approval",
          },
        },
      ],
    });

    const affordances = screen.getByTestId("list-item-affordances");
    expect(affordances.className).toContain("flex-wrap");
    expect(screen.getByText(/particularly detailed/).className).toContain(
      "max-w-full"
    );
    expect(
      screen.getByRole("button", { name: /Request approval/ }).className
    ).toContain("whitespace-normal");
  });

  it("collapses then expands the structured long-list tail", () => {
    renderList({
      id: "work",
      type: "list",
      collapse: { after: 1, label: "More work" },
      items: [
        { id: "one", text: "One" },
        { id: "two", text: "Two" },
      ],
    });
    const toggle = screen.getByRole("button", { name: "More work" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Two")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Two")).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByText("Two")).toBeNull();
  });

  it("submits a compact item action with its item id", () => {
    renderList({
      id: "work",
      type: "list",
      items: [
        {
          id: "one",
          text: "One",
          action: { id: "approve", label: "Approve", intent: "approve" },
        },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "action",
        blockId: "work",
        itemId: "one",
        actionId: "approve",
      }),
      expect.any(Object)
    );
  });
});
