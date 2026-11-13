// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SystemEventEntry } from "./system-event-entry";
import { parseCheckNotice } from "./pull-request-check-results";

afterEach(cleanup);

// Shape produced by apps/server/src/agents/pull-request-check-notice.ts.
const notice = [
  "[#1439](<https://github.com/a/b/pull/1439>) — Failing · 4 passed, 1 failed, 2 pending, 1 cancelled",
  "- [Browser \\[e2e\\] regression](<https://github.com/a/b/runs/1?x=1&amp;y=2>) — failed · 12m 30s",
  "- Type check — passed · 58s",
  "- +2 more",
  "",
  "0c935fb3a917 · 2026-11-10 17:42Z · Info only; no action authorized.",
].join("\n");
const checks = (details: string, status?: "Failing") =>
  render(
    <SystemEventEntry
      event={{
        category: "checks",
        summary: "Pull request checks",
        ...(status ? { status } : {}),
        details,
        head: "0c935fb3a917c37c",
        at: "2026-11-10T17:42:00Z",
        resource: {
          label: "Preserve observation delivery provenance",
          url: "https://github.com/a/b/pull/1439",
        },
      }}
    />
  );

describe("system event presentation", () => {
  it("keeps risk separate from check status and exposes details to keyboard users", () => {
    render(
      <SystemEventEntry
        event={{
          category: "risk",
          summary: "Merge-risk assessment",
          risk: "routine",
          details: "Exact-head observation",
          head: "abcdef1234",
          at: "2026-11-10T17:42:00Z",
          resource: {
            label: "PR #1439",
            url: "https://github.com/a/b/pull/1439",
          },
        }}
      />
    );
    expect(screen.getByText("Routine")).toBeTruthy();
    expect(screen.queryByText("Passing")).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link").getAttribute("target")).toBe("_blank");
    expect(screen.getByRole("link").getAttribute("rel")).toBe("noreferrer");
    const button = screen.getByRole("button", { name: "Details" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Exact-head observation")).toBeTruthy();
    expect(screen.getByText(/Not merge approval/)).toBeTruthy();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows one light summary: linked PR, status and counts by status", () => {
    const view = checks(notice, "Failing");
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
    expect(screen.queryByText("Observation details")).toBeNull();
    expect(screen.queryByText("Pull request checks")).toBeNull();
    const pr = screen.getByRole("link", {
      name: "PR #1439 Preserve observation delivery provenance",
    });
    expect(pr.getAttribute("href")).toBe("https://github.com/a/b/pull/1439");
    expect(screen.getByLabelText("Check summary").textContent).toBe(
      "Failing· 4 passed· 1 failed· 2 pending· 1 cancelled"
    );
    expect(screen.getAllByText("Failing")).toHaveLength(1);
    // Named rows only exist for some notices, so no card shows them.
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.queryByText(/Type check|\+2 more/)).toBeNull();
    // No qualifiers or disclaimers; commit and time appear once.
    expect(screen.queryByText(/aren’t named/)).toBeNull();
    expect(screen.queryByText(/Newly finished/)).toBeNull();
    expect(screen.queryByText(/Info only|merge approval/)).toBeNull();
    expect(screen.queryByText(/no action authorized/)).toBeNull();
    expect(view.container.querySelectorAll("code")).toHaveLength(1);
    expect(screen.getByText("0c935fb")).toBeTruthy();
    expect(view.container.querySelectorAll("time")).toHaveLength(1);
  });

  it("gives cards with and without named checks the same shape", () => {
    const summaries = [
      "#1 — Passing · 6 passed\n- Lint — passed · 20s",
      "#1 — Passing · 6 passed",
    ].map((details) => {
      const view = checks(details);
      const text = screen.getByLabelText("Check summary").textContent;
      const html = view.container.innerHTML.replace(/>[^<]*</g, "><");
      cleanup();
      return { text, html };
    });
    expect(summaries[0]).toEqual(summaries[1]);
    expect(summaries[0].text).toBe("Passing· 6 passed");
  });

  it("takes the PR number from the notice when the resource has none", () => {
    render(
      <SystemEventEntry
        event={{
          category: "checks",
          summary: "Pull request checks",
          details:
            "[#77](<https://github.com/a/b/pull/77>) — Passing · 2 passed",
        }}
      />
    );
    expect(
      screen.getByRole("link", { name: "PR #77" }).getAttribute("href")
    ).toBe("https://github.com/a/b/pull/77");
    expect(screen.getByLabelText("Check summary").textContent).toBe(
      "Passing· 2 passed"
    );
  });

  it("does not repeat a number already in the title or show a placeholder title", () => {
    const { rerender } = checks("");
    rerender(
      <SystemEventEntry
        event={{
          category: "checks",
          summary: "Pull request checks",
          details: "",
          resource: {
            label: "PR #1439 · Fix it",
            url: "https://github.com/a/b/pull/1439",
          },
        }}
      />
    );
    expect(screen.getByRole("link", { name: "PR #1439 Fix it" })).toBeTruthy();
    for (const label of ["PR #1439", "#1439"]) {
      rerender(
        <SystemEventEntry
          event={{
            category: "checks",
            summary: "Pull request checks",
            details: "",
            resource: { label, url: "https://github.com/a/b/pull/1439" },
          }}
        />
      );
      expect(screen.getByRole("link", { name: "PR #1439" })).toBeTruthy();
    }
    rerender(
      <SystemEventEntry
        event={{
          category: "checks",
          summary: "Pull request checks",
          details: "",
          resource: {
            label: "View pull request",
            url: "https://github.com/a/b/pull/1439",
          },
        }}
      />
    );
    expect(screen.getByRole("link", { name: "PR #1439" })).toBeTruthy();
  });

  it("falls back to the full text, visibly, when the notice shape is unknown", () => {
    checks("Checks changed on a legacy notice");
    expect(screen.getByText("Checks changed on a legacy notice")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
    expect(screen.queryByLabelText("Check summary")).toBeNull();
  });

  it("renders no invented results when check data is missing", () => {
    checks("");
    expect(screen.getByLabelText("Check summary").textContent).toBe(
      "No check results"
    );
    expect(screen.queryByText(/Passing|Failing|Pending|Mixed/)).toBeNull();
  });

  it("refuses partially recognised notices rather than dropping lines", () => {
    expect(
      parseCheckNotice(notice.replace("- Type check", "* Type check"))
    ).toBeUndefined();
    expect(
      parseCheckNotice(
        "#1 — Failing · 1 failed\n- [x](<javascript:alert(1)>) — failed"
      )?.checks[0]
    ).toEqual({ name: "x", outcome: "failed" });
    // Percent-encoded characters stay encoded; only &amp; is undone.
    expect(
      parseCheckNotice(
        "#1 — Failing · 1 failed\n- [x](<https://e.com/a%5Cb?q=%3Cx%3E&amp;r=1>) — failed"
      )?.checks[0].url
    ).toBe("https://e.com/a%5Cb?q=%3Cx%3E&r=1");
  });

  it("takes counts from the snapshot, not from the named rows", () => {
    checks(
      [
        "#1449 — Failing · 2 passed, 1 failed, 5 pending",
        "- Type check — passed · 58s",
        "- [Browser e2e](<https://github.com/a/b/runs/9>) — failed · 3m",
        "",
        "4d9ea93eb810 · 2026-11-12 16:54Z · Info only; no action authorized.",
      ].join("\n")
    );
    expect(screen.getByLabelText("Check summary").textContent).toBe(
      "Failing· 2 passed· 1 failed· 5 pending"
    );
  });

  it("parses the PR reference from the notice header", () => {
    expect(parseCheckNotice(notice)?.pr).toEqual({
      number: "1439",
      url: "https://github.com/a/b/pull/1439",
    });
    expect(parseCheckNotice("#5 — Pending · 1 pending")?.pr).toEqual({
      number: "5",
    });
  });
});
