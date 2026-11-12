// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  fireEvent,
  within,
} from "@testing-library/react";
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

  it("shows check totals and per-check results inline, without a disclosure", () => {
    const view = checks(notice, "Failing");
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
    expect(screen.queryByText("Observation details")).toBeNull();
    expect(screen.getAllByText("Failing")).toHaveLength(1);
    const totals = screen.getByLabelText("Check totals");
    expect(totals.textContent).toBe("4 passed1 failed2 pending1 cancelled");
    const results = within(screen.getByLabelText("Newly finished checks"));
    const failed = results.getByRole("link", {
      name: "Browser [e2e] regression",
    });
    expect(failed.getAttribute("href")).toBe(
      "https://github.com/a/b/runs/1?x=1&y=2"
    );
    expect(results.getByText("failed · 12m 30s")).toBeTruthy();
    expect(results.getByText("Type check")).toBeTruthy();
    expect(results.getByText("+2 more newly finished, not shown")).toBeTruthy();
    expect(
      screen.getByText("Pending checks aren’t named in this update")
    ).toBeTruthy();
    // Commit, time and informational note appear once; no footer boilerplate.
    expect(view.container.querySelectorAll("code")).toHaveLength(1);
    expect(screen.getByText("0c935fb")).toBeTruthy();
    expect(view.container.querySelectorAll("time")).toHaveLength(1);
    expect(screen.getAllByText(/Info only/)).toHaveLength(1);
    expect(screen.queryByText(/no action authorized/)).toBeNull();
    expect(screen.queryByText(/#1439/)).toBeNull();
    expect(
      screen.getByRole("link", {
        name: "Preserve observation delivery provenance",
      })
    ).toBeTruthy();
  });

  it("falls back to the full text, visibly, when the notice shape is unknown", () => {
    checks("Checks changed on a legacy notice");
    expect(screen.getByText("Checks changed on a legacy notice")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
    expect(screen.queryByLabelText("Check totals")).toBeNull();
  });

  it("renders no invented results when check data is missing", () => {
    checks("");
    expect(screen.queryByLabelText("Check totals")).toBeNull();
    expect(screen.queryByLabelText("Newly finished checks")).toBeNull();
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

  it("puts failures first and never presents passed rows as the pending ones", () => {
    const view = checks(
      [
        "#1449 — Failing · 2 passed, 1 failed, 5 pending",
        "- Type check — passed · 58s",
        "- Lint — passed · 20s",
        "- [Browser e2e](<https://github.com/a/b/runs/9>) — failed · 3m",
        "",
        "4d9ea93eb810 · 2026-11-12 16:54Z · Info only; no action authorized.",
      ].join("\n")
    );
    const text = view.container.textContent ?? "";
    expect(text.indexOf("Pending checks aren’t named")).toBeLessThan(
      text.indexOf("Newly finished")
    );
    const rows = within(screen.getByLabelText("Newly finished checks"))
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(rows[0]).toMatch(/^Browser e2efailed/);
    expect(rows.slice(1)).toEqual([
      "Type checkpassed · 58s",
      "Lintpassed · 20s",
    ]);
  });

  it("omits the outstanding line when nothing is pending", () => {
    checks("#1 — Passing · 2 passed\n- Lint — passed · 20s");
    expect(screen.queryByText(/aren’t named/)).toBeNull();
  });
});
