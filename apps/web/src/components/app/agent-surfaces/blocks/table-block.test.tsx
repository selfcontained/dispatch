// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";

import { TableBlockView } from "./table-block";
import type { TableBlock } from "../types";

const mutate = vi.fn();
vi.mock("@/hooks/use-agent-surfaces", () => ({
  makeIdempotencyKey: () => "idem-test",
  useSubmitSurfaceInteraction: () => ({ mutate }),
}));

afterEach(() => {
  cleanup();
  mutate.mockReset();
  vi.restoreAllMocks();
});

function linkTable(value: string): TableBlock {
  return {
    id: "links",
    type: "table",
    columns: [{ id: "link", label: "Link", format: "url" }],
    rows: [{ id: "one", cells: { link: value } }],
  };
}

function renderTable(block: TableBlock) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TableBlockView
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

describe("TableBlockView URL cells", () => {
  it.each([
    "https://example.com/path",
    "http://example.com",
    "mailto:hello@example.com",
  ])("renders an allowed URL as a link: %s", (value) => {
    renderTable(linkTable(value));
    expect(screen.getByRole("link", { name: value }).getAttribute("href")).toBe(
      value
    );
  });

  it.each(["javascript:alert(1)", "data:text/html,bad", "/relative"])(
    "renders an unsafe or version-skewed URL as inert text: %s",
    (value) => {
      renderTable(linkTable(value));
      expect(screen.queryByRole("link", { name: value })).toBeNull();
      expect(screen.getByText(value).tagName).toBe("SPAN");
    }
  );

  it("gives the secondary-column disclosure its own coarse-pointer target", () => {
    const block: TableBlock = {
      ...linkTable("https://example.com"),
      columns: [
        { id: "link", label: "Link", format: "url" },
        { id: "detail", label: "Detail", priority: "secondary" },
      ],
      rows: [
        {
          id: "one",
          cells: { link: "https://example.com", detail: "More information" },
        },
      ],
    };

    renderTable(block);
    const disclosure = screen.getByRole("button", {
      name: "Show details for https://example.com",
    });
    expect(disclosure.className).toContain("h-6");
    expect(disclosure.className).toContain("[@media(pointer:coarse)]:min-h-11");
    const detailsId = disclosure.getAttribute("aria-controls");
    expect(detailsId).toBeTruthy();
    const detailsRow = document.getElementById(detailsId!);
    expect(detailsRow?.hidden).toBe(true);

    fireEvent.click(disclosure);
    expect(screen.getByText("More information")).not.toBeNull();
    expect(detailsRow?.hidden).toBe(false);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Hide details for https://example.com",
      })
    );
    expect(detailsRow?.hidden).toBe(true);
  });

  it("preserves authored calendar days when formatting date-only values", () => {
    const format = vi.spyOn(Date.prototype, "toLocaleDateString");
    renderTable({
      id: "dates",
      type: "table",
      columns: [{ id: "checked", label: "Checked", format: "date" }],
      rows: [{ id: "one", cells: { checked: "2026-08-27" } }],
    });

    expect(format).toHaveBeenCalledWith(undefined, { timeZone: "UTC" });
    expect(
      screen.getByText(
        new Date("2026-08-27T00:00:00.000Z").toLocaleDateString(undefined, {
          timeZone: "UTC",
        })
      )
    ).toBeTruthy();
  });

  it("renders a decision-critical badge column (e.g. Risk) inline, without needing expansion", () => {
    // Mirrors the seeded "Release paths" table: Option/Time/Risk are all
    // comparison-critical, so none should default to (or be authored as)
    // secondary — a user must see Risk without an extra click.
    const block: TableBlock = {
      id: "release-paths",
      type: "table",
      columns: [
        { id: "option", label: "Option", priority: "primary" },
        { id: "time", label: "Time", priority: "primary" },
        {
          id: "risk",
          label: "Risk",
          format: "badge",
          priority: "primary",
          badgeVariants: { Lower: "success", Higher: "warning" },
        },
      ],
      rows: [
        {
          id: "canary",
          cells: { option: "Canary", time: "~30 min", risk: "Lower" },
        },
        {
          id: "direct",
          cells: { option: "Direct", time: "~8 min", risk: "Higher" },
        },
      ],
    };

    renderTable(block);

    expect(screen.getByText("Lower")).not.toBeNull();
    expect(screen.getByText("Higher")).not.toBeNull();
    // No disclosure affordance at all — nothing is behind a click.
    expect(
      screen.queryByRole("button", { name: /Show details for/ })
    ).toBeNull();
  });

  it("keeps row actions compact and submits with the row id", () => {
    const block: TableBlock = {
      id: "deployments",
      type: "table",
      title: "Deployments",
      showItemCount: true,
      columns: [
        { id: "name", label: "Name" },
        { id: "detail", label: "Detail", priority: "secondary" },
      ],
      rows: [
        {
          id: "one",
          cells: { name: "One", detail: "First detail" },
          actions: [{ id: "approve", label: "Approve", intent: "approve" }],
        },
        { id: "two", cells: { name: "Two", detail: "Second detail" } },
      ],
    };
    renderTable(block);
    expect(screen.getByText("(2)")).toBeTruthy();
    const rows = document.querySelectorAll("tbody tr[data-row-id]");
    expect(rows[0].querySelectorAll("td").length).toBe(
      rows[1].querySelectorAll("td").length
    );
    const actionButton = screen.getByRole("button", {
      name: "Approve for One",
    });
    // Ghost row affordance: no extra row height, quiet by default.
    expect(actionButton.className).toContain("h-6");
    fireEvent.click(actionButton);
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "one", actionId: "approve" }),
      expect.any(Object)
    );
  });

  it("distinguishes repeated action labels with primary row context", () => {
    renderTable({
      id: "deployments",
      type: "table",
      columns: [{ id: "name", label: "Name" }],
      rows: [
        {
          id: "one",
          cells: { name: "Canary" },
          actions: [{ id: "retry", label: "Retry", intent: "retry" }],
        },
        {
          id: "two",
          cells: { name: "Production" },
          actions: [{ id: "retry", label: "Retry", intent: "retry" }],
        },
      ],
    });

    expect(
      screen.getByRole("button", { name: "Retry for Canary" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Retry for Production" })
    ).toBeTruthy();
  });

  it("renders a 2-column action-free table as a key/value list", () => {
    renderTable({
      id: "impact",
      type: "table",
      columns: [
        { id: "metric", label: "Metric" },
        { id: "value", label: "Value" },
      ],
      rows: [
        { id: "duration", cells: { metric: "Duration", value: "47 minutes" } },
        {
          id: "revenue",
          cells: { metric: "Revenue impact", value: "$18,600" },
        },
      ],
    });

    // No table chrome: the boilerplate header row disappears entirely.
    expect(document.querySelector("table")).toBeNull();
    expect(screen.queryByText("Metric")).toBeNull();
    expect(screen.getByText("Duration")).toBeTruthy();
    expect(screen.getByText("$18,600")).toBeTruthy();
  });

  it("demotes columns past the 3-primary budget behind the row disclosure", () => {
    renderTable({
      id: "wide",
      type: "table",
      columns: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
        { id: "d", label: "D" },
      ],
      rows: [{ id: "one", cells: { a: "1", b: "2", c: "3", d: "4" } }],
    });

    expect(screen.queryByRole("columnheader", { name: "D" })).toBeNull();
    expect(
      screen.getByRole("button", { name: /Show details for/ })
    ).toBeTruthy();
  });
});
