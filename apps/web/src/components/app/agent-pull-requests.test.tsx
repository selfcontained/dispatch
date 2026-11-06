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
import { AgentPullRequests, PullRequestRow } from "./agent-pull-requests";
import { api } from "@/lib/api";
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
afterEach(cleanup);
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
