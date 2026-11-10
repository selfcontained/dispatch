// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  AgentPullRequests,
  PullRequestRow,
  checkDuration,
} from "./agent-pull-requests";
import { api } from "@/lib/api";
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("removes immediately, prevents row activation, and restores a failed dismissal for retry", async () => {
  const pr = {
    url: "https://github.com/a/b/pull/1",
    title: "Change",
    status: "Open",
  };
  let reject!: (error: Error) => void;
  vi.mocked(api).mockImplementation((_url, options) =>
    options?.method === "POST"
      ? new Promise((_resolve, fail) => {
          reject = fail;
        })
      : (Promise.resolve({ pullRequests: [pr] }) as never)
  );
  const selected = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <div onClick={selected}>
        <AgentPullRequests agentId="a" />
      </div>
    </QueryClientProvider>
  );
  const button = await screen.findByRole("button", {
    name: "Dismiss a/b #1 from sidebar",
  });
  fireEvent.click(button);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Dismiss a/b #1 from sidebar" })
    ).toBeNull()
  );
  expect(selected).not.toHaveBeenCalled();
  reject(new Error("offline"));
  await screen.findByRole("alert");
  await screen.findByRole("button", { name: "Dismiss a/b #1 from sidebar" });
});
it("retains an earlier request's failure when a later dismissal succeeds", async () => {
  const prs = [1, 2].map((n) => ({
    url: `https://github.com/a/b/pull/${n}`,
    title: `Change ${n}`,
    status: "Open",
  }));
  let failFirst!: (error: Error) => void;
  let succeedSecond!: (value: unknown) => void;
  vi.mocked(api).mockImplementation((_url, options) => {
    if (options?.method !== "POST")
      return Promise.resolve({ pullRequests: prs }) as never;
    const { url } = JSON.parse(options.body as string);
    return new Promise((resolve, reject) => {
      if (url.endsWith("/1")) failFirst = reject;
      else succeedSecond = resolve;
    }) as never;
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AgentPullRequests agentId="a" />
    </QueryClientProvider>
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Dismiss a/b #1 from sidebar" })
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Dismiss a/b #2 from sidebar" })
  );
  await waitFor(() => expect(succeedSecond).toBeDefined());
  failFirst(new Error("offline"));
  succeedSecond({});
  await screen.findByRole("alert");
  await screen.findByRole("button", { name: "Dismiss a/b #1 from sidebar" });
  expect(
    screen.queryByRole("button", { name: "Dismiss a/b #2 from sidebar" })
  ).toBeNull();
});

it.each([
  [1, 1, 1, "text-status-blocked", "circle-x"],
  [1, 0, 1, "text-status-waiting", "clock"],
  [1, 0, 0, "text-status-working", "circle-check"],
])(
  "shows one priority icon for passed=%s failed=%s pending=%s",
  (passed, failed, pending, color, icon) => {
    render(
      <PullRequestRow
        isError={false}
        onDismiss={() => {}}
        pr={{
          url: "https://github.com/a/b/pull/1",
          title: "Change",
          status: "Draft",
          ci: {
            checkedAt: "2026-11-06T00:00:00Z",
            headSha: "abc",
            availability: "available",
            summary: {
              status: failed ? "failing" : pending ? "pending" : "passing",
              total: Number(passed) + Number(failed) + Number(pending),
              passed: Number(passed),
              failed: Number(failed),
              pending: Number(pending),
              skipped: 0,
            },
            checks: [],
          },
        }}
      />
    );
    const image = screen.getByRole("img");
    expect(image.className).toContain(color);
    expect(
      image.querySelector("svg")?.classList.contains(`lucide-${icon}`)
    ).toBe(true);
    expect(image.querySelectorAll("[stroke-dasharray]").length).toBe(0);
  }
);

it("labels each detailed check once through its status icon beside the name", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  render(
    <PullRequestRow
      isError={false}
      onDismiss={() => {}}
      pr={{
        url: "https://github.com/a/b/pull/1",
        title: "Change",
        status: "Draft",
        ci: {
          checkedAt: "2026-11-06T00:00:00Z",
          headSha: "abc",
          availability: "available",
          summary: {
            status: "failing",
            total: 1,
            passed: 0,
            failed: 1,
            pending: 0,
            skipped: 0,
          },
          checks: [
            {
              name: "Build",
              status: "COMPLETED",
              conclusion: "FAILURE",
              detailsUrl: "https://github.com/a/b/actions/runs/1",
            },
          ],
        },
      }}
    />
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Check details for pull request #1" })
  );
  const icon = await screen.findByRole("img", { name: "Failed" });
  expect(icon.getAttribute("title")).toBe("Failed");
  expect(icon.closest("li")?.textContent).toBe("Build");
  expect(screen.getByRole("link", { name: "Build" }).getAttribute("href")).toBe(
    "https://github.com/a/b/actions/runs/1"
  );
});

it("uses completed runtime or elapsed time at observation, without inventing durations", () => {
  const check = {
    name: "Build",
    status: "IN_PROGRESS",
    conclusion: null,
    detailsUrl: null,
    startedAt: "2026-11-06T00:00:00Z",
  };
  expect(checkDuration(check, "2026-11-06T00:01:23Z")).toBe("1m 23s");
  expect(
    checkDuration(
      { ...check, status: "COMPLETED", completedAt: "2026-11-06T01:02:03Z" },
      "2026-11-06T02:00:00Z"
    )
  ).toBe("1h 2m");
  expect(
    checkDuration({ ...check, startedAt: undefined }, "2026-11-06T00:01:23Z")
  ).toBeNull();
  expect(
    checkDuration({ ...check, status: "QUEUED" }, "2026-11-06T00:01:23Z")
  ).toBeNull();
  expect(
    checkDuration(
      { ...check, completedAt: "2026-11-05T23:59:59Z" },
      "2026-11-06T00:01:23Z"
    )
  ).toBeNull();
});

it.each([
  ["2026-11-06T00:00:00Z", "2026-11-06T00:02:00Z", "2026-11-06T00:01:00Z"],
  ["2026-11-06T00:02:00Z", undefined, "2026-11-06T00:01:00Z"],
  ["bad", "2026-11-06T00:01:00Z", "2026-11-06T00:02:00Z"],
  ["2026-11-06T00:00:00Z", "bad", "2026-11-06T00:02:00Z"],
  ["2026-11-06T00:00:00Z", "2026-11-06T00:01:00Z", "bad"],
])(
  "hides invalid or future check timing",
  (startedAt, completedAt, observed) => {
    expect(
      checkDuration(
        {
          name: "Build",
          status: "IN_PROGRESS",
          conclusion: null,
          detailsUrl: null,
          startedAt,
          completedAt,
        },
        observed!
      )
    ).toBeNull();
  }
);

it("targets a single PR, disables refresh while pending and retains checks on failure", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  const pr = {
    url: "https://github.com/a/b/pull/1",
    title: "Change",
    status: "Open",
    ci: {
      checkedAt: "2026-11-06T10:00:00Z",
      headSha: "abc1234",
      availability: "available",
      summary: {
        status: "passed",
        total: 1,
        passed: 1,
        failed: 0,
        pending: 0,
        skipped: 0,
      },
      checks: [{ name: "Build", status: "COMPLETED", conclusion: "SUCCESS" }],
    },
  };
  let reject!: (error: Error) => void;
  vi.mocked(api).mockImplementation((_url, options) =>
    options?.method === "POST"
      ? new Promise((_resolve, fail) => {
          reject = fail;
        })
      : (Promise.resolve({ pullRequests: [pr] }) as never)
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AgentPullRequests agentId="a" />
    </QueryClientProvider>
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Check details for pull request #1",
    })
  );
  const button = await screen.findByRole("button", {
    name: "Refresh pull request checks",
  });
  fireEvent.click(button);
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
  expect(api).toHaveBeenCalledWith(
    "/api/v1/agents/a/pull-requests/refresh",
    expect.objectContaining({ body: JSON.stringify({ url: pr.url }) })
  );
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(
    screen.getByRole("button", { name: "Check details for pull request #1" })
  );
  const reopened = await screen.findByRole("button", {
    name: "Refresh pull request checks",
  });
  expect(reopened.hasAttribute("disabled")).toBe(true);
  reject(new Error("offline"));
  await screen.findByRole("alert");
  expect(screen.getByText("Build")).toBeTruthy();
  expect(reopened.hasAttribute("disabled")).toBe(false);
});

it("offers refresh before a CI snapshot is available", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.mocked(api).mockResolvedValue({
    pullRequests: [
      {
        url: "https://github.com/a/b/pull/2",
        title: "Unavailable",
        status: "Unavailable",
      },
    ],
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AgentPullRequests agentId="a" />
    </QueryClientProvider>
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Check details for pull request #2",
    })
  );
  expect(
    await screen.findByRole("button", { name: "Refresh pull request checks" })
  ).toBeTruthy();
  expect(screen.getByText(/Never/)).toBeTruthy();
});

it("shows the merge-risk recommendation on the row and its details in the popover", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  render(
    <PullRequestRow
      isError={false}
      onDismiss={() => {}}
      pr={{
        url: "https://github.com/a/b/pull/1",
        title: "Change",
        status: "Open",
        mergeRisk: {
          verdict: "human_review",
          changeRisk: 2.3,
          changeRiskLabel: "high",
          reviewAdequate: 0.91,
          descriptionMatches: 0.4,
          newSurface: 0.9,
          routineProbability: 0.1,
          humanReviewProbability: 0.9,
          confidence: 0.95,
          status: "ok",
          promptVersion: "merge-risk-v2",
          headSha: "abcdef1234",
          assessedAt: "2026-11-09T12:00:00Z",
        },
      }}
    />
  );
  expect(
    screen.getByTestId("merge-risk-marker").getAttribute("aria-label")
  ).toBe("Merge risk: Read before merge");
  fireEvent.click(
    screen.getByRole("button", {
      name: "Merge risk for pull request #1: Read before merge",
    })
  );
  expect(screen.getByTestId("merge-risk-badge").textContent).toBe(
    "Read before merge"
  );
  expect(
    (await screen.findByText("Change risk")).nextElementSibling?.textContent
  ).toBe("high");
  expect(
    screen.getByText("Description matches").nextElementSibling?.textContent
  ).toBe("40%");
  expect(screen.getByText(/Not merge approval/i)).toBeTruthy();
});

it("keeps inconclusive assessments discoverable on the row", () => {
  render(
    <PullRequestRow
      isError={false}
      onDismiss={() => {}}
      pr={{
        url: "https://github.com/a/b/pull/1",
        title: "Change",
        status: "Open",
        mergeRisk: {
          verdict: "abstain",
          changeRisk: 0.5,
          changeRiskLabel: "low",
          reviewAdequate: null,
          descriptionMatches: null,
          newSurface: null,
          routineProbability: 0.6,
          humanReviewProbability: 0.3,
          confidence: 0.5,
          status: "ok",
          promptVersion: "merge-risk-v2",
          headSha: "abcdef1234",
          assessedAt: "2026-11-09T12:00:00Z",
        },
      }}
    />
  );
  expect(
    screen.getByTestId("merge-risk-marker").getAttribute("aria-label")
  ).toContain("No recommendation");
});

it("updates waiting to evaluating to inconclusive without presenting prior-head history as current", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  const { previewPullRequests } = await import("./agent-pull-requests.preview");
  const waiting = previewPullRequests.find(
    (pr) => pr.mergeRisk?.displayState === "waiting_ci"
  )!;
  const props = { isError: false, onDismiss: () => {} };
  const { rerender } = render(<PullRequestRow {...props} pr={waiting} />);
  fireEvent.click(
    screen.getByRole("button", { name: /Merge risk for pull request/ })
  );
  expect(screen.getByText("Previous assessment")).toBeTruthy();
  expect(
    screen.queryByText(/Does not describe current merge readiness/)
  ).toBeNull();
  expect(screen.getByText("a1b2c3d")).toBeTruthy();
  rerender(
    <PullRequestRow
      {...props}
      pr={{
        ...waiting,
        mergeRisk: { ...waiting.mergeRisk!, displayState: "evaluating" },
      }}
    />
  );
  expect(
    screen.getByRole("button", { name: /Risk · evaluating/ })
  ).toBeTruthy();
  rerender(
    <PullRequestRow
      {...props}
      pr={{
        ...waiting,
        mergeRisk: {
          ...waiting.mergeRisk!,
          displayState: undefined,
          previous: undefined,
          verdict: "abstain",
        },
      }}
    />
  );
  expect(
    screen.getByRole("button", { name: /No recommendation/ })
  ).toBeTruthy();
  expect(screen.queryByText("Previous assessment")).toBeNull();
});

it("hides disabled risk even when PR details are opened", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  const { previewPullRequests } = await import("./agent-pull-requests.preview");
  const disabled = previewPullRequests.find(
    (pr) => pr.mergeRisk?.displayState === "disabled"
  )!;
  render(<PullRequestRow isError={false} onDismiss={() => {}} pr={disabled} />);
  expect(screen.queryByTestId("merge-risk-marker")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: /Check details for pull request/ })
  );
  expect(screen.queryByTestId("merge-risk-badge")).toBeNull();
  expect(screen.queryByText("Merge risk")).toBeNull();
  expect(screen.getByText("Checks")).toBeTruthy();
});

it("shows current CI independently beside the same risk assessment as checks change", async () => {
  const { previewPullRequests } = await import("./agent-pull-requests.preview");
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  const base = previewPullRequests[0]!;
  const props = { isError: false, onDismiss: () => {} };
  const { rerender } = render(<PullRequestRow {...props} pr={base} />);
  fireEvent.click(
    screen.getByRole("button", { name: /Merge risk for pull request #1380/ })
  );
  expect(screen.getByLabelText("Current CI: 1 failed").title).toContain(
    "required checks must pass"
  );
  expect(screen.getByTestId("merge-risk-badge").textContent).toBe("Routine");
  rerender(
    <PullRequestRow
      {...props}
      pr={{
        ...base,
        ci: {
          ...base.ci!,
          summary: { ...base.ci!.summary, failed: 0, pending: 1 },
        },
      }}
    />
  );
  expect(screen.getByLabelText("Current CI: 1 pending")).toBeTruthy();
  expect(screen.getByTestId("merge-risk-badge").textContent).toBe("Routine");
});
