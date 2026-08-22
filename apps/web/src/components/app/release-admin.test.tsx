// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReleaseInfo, ReleaseJob } from "@/hooks/use-release-stream";

import { ReleasesAdmin } from "./release-admin";
import type { GitHubRelease } from "./release-utils";

vi.mock("@/lib/pwa-update", () => ({ reloadApp: vi.fn() }));
vi.mock("@/lib/version", () => ({ noteServerVersion: vi.fn() }));
vi.mock("@/lib/energy-metrics", () => ({
  recordReleaseManagerPollFire: vi.fn(),
}));

/**
 * The page opens a release SSE stream on mount; jsdom has no EventSource,
 * and holding the instance lets a test push a create-job snapshot in the
 * same shape the server would.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  emit(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
  }
}

function lastSource(): FakeEventSource {
  const source = FakeEventSource.instances.at(-1);
  if (!source) throw new Error("no EventSource was created");
  return source;
}

function makeInfo(overrides: Partial<ReleaseInfo> = {}): ReleaseInfo {
  return {
    currentTag: "v1.2.3",
    channel: "stable",
    isAdmin: true,
    latestTag: "v1.2.3",
    updateAvailable: false,
    latestRelease: null,
    unreleasedCount: 0,
    commits: [],
    ...overrides,
  } as ReleaseInfo;
}

function makeRelease(overrides: Partial<GitHubRelease> = {}): GitHubRelease {
  return {
    tag: "v1.2.3",
    publishedAt: "2026-08-01T12:00:00.000Z",
    isPrerelease: false,
    url: "https://github.test/releases/v1.2.3",
    ...overrides,
  };
}

/** The wire type itself, so a typo'd phase fails typecheck instead of a test. */
type CreateJobShape = Extract<ReleaseJob, { jobType: "create" }>;

function makeCreateJob(
  overrides: Partial<CreateJobShape> = {}
): CreateJobShape {
  return {
    jobType: "create",
    versionType: "patch",
    phase: "watching",
    startedAt: "2026-08-01T12:00:00.000Z",
    log: ["triggering"],
    runUrl: null,
    tag: null,
    error: null,
    progress: null,
    ...overrides,
  };
}

type Handler = (init?: RequestInit) => unknown;

/** Every response needs `headers` — the stream hook reads a version header. */
const nullHeaders = { get: () => null };

/**
 * Routes by URL so a test only has to state the endpoints it cares about;
 * anything else answers "not ok".
 */
function installFetch(routes: Record<string, Handler>) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const handler = routes[url];
    if (!handler) return Promise.resolve({ ok: false, headers: nullHeaders });
    return Promise.resolve(handler(init));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function okJson(body: unknown) {
  return { ok: true, headers: nullHeaders, json: () => Promise.resolve(body) };
}

function errJson(body: unknown) {
  return { ok: false, headers: nullHeaders, json: () => Promise.resolve(body) };
}

/** Mount the page and wait for the two mount fetches to settle. */
async function renderAdmin(routes: Record<string, Handler> = {}) {
  const fetchMock = installFetch({
    "/api/v1/release/info": () => okJson(makeInfo()),
    "/api/v1/releases": () => okJson({ releases: [] }),
    ...routes,
  });
  render(<ReleasesAdmin />);
  await waitFor(() =>
    expect(fetchMock.mock.calls.some((c) => c[0] === "/api/v1/releases")).toBe(
      true
    )
  );
  return fetchMock;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("ReleasesAdmin — unreleased changes", () => {
  it("prefers the fetch-error banner over the commit count it cannot trust", async () => {
    await renderAdmin({
      "/api/v1/release/info": () =>
        okJson(
          makeInfo({
            unreleasedFetchError: "git failed\nstderr=fatal: no upstream",
            unreleasedCount: 4,
            refMissing: true,
          })
        ),
    });

    expect(
      await screen.findByText(/unreleased commit info is unavailable/)
    ).toBeTruthy();
    // cleanError strips the wrapper and the `fatal:` prefix.
    expect(screen.getByText("no upstream")).toBeTruthy();
  });

  it("falls back to the missing-ref banner when only the ref is missing", async () => {
    await renderAdmin({
      "/api/v1/release/info": () =>
        okJson(
          makeInfo({ refMissing: true, currentTag: "v9.9.9", commits: [] })
        ),
    });

    const banner = await screen.findByText(/not found in origin/);
    expect(within(banner).getByText("v9.9.9")).toBeTruthy();
  });

  it("lists the commits it has and counts the ones it does not", async () => {
    await renderAdmin({
      "/api/v1/release/info": () =>
        okJson(
          makeInfo({
            unreleasedCount: 5,
            commits: [
              { sha: "aaa1111", subject: "first change" },
              { sha: "bbb2222", subject: "second change" },
            ],
          })
        ),
    });

    expect(await screen.findByText(/5 unreleased/)).toBeTruthy();
    expect(screen.getByText("first change")).toBeTruthy();
    expect(screen.getByText("aaa1111")).toBeTruthy();
    expect(screen.getByText("+3 more")).toBeTruthy();
  });

  it("singularizes a lone unreleased commit and omits the overflow line", async () => {
    await renderAdmin({
      "/api/v1/release/info": () =>
        okJson(
          makeInfo({
            unreleasedCount: 1,
            commits: [{ sha: "aaa1111", subject: "only change" }],
          })
        ),
    });

    expect(await screen.findByText(/1 unreleased/)).toBeTruthy();
    expect(screen.getByText(/1 unreleased/).textContent).toContain("commit on");
    expect(screen.getByText(/1 unreleased/).textContent).not.toContain(
      "commits"
    );
    expect(screen.queryByText(/more$/)).toBeNull();
  });

  it("surfaces an info request failure instead of an empty page", async () => {
    await renderAdmin({
      "/api/v1/release/info": () => errJson({ error: "boom: stderr=denied" }),
    });

    expect(await screen.findByText("denied")).toBeTruthy();
    expect(screen.queryByText("No unreleased commits on main")).toBeNull();
  });

  it("refetches both endpoints when the refresh control is used", async () => {
    const fetchMock = await renderAdmin();

    const refresh = screen.getByLabelText("Refresh unreleased changes");
    await act(async () => {
      fireEvent.click(refresh);
    });

    const infoCalls = fetchMock.mock.calls.filter(
      (c) => c[0] === "/api/v1/release/info"
    );
    const releaseCalls = fetchMock.mock.calls.filter(
      (c) => c[0] === "/api/v1/releases"
    );
    expect(infoCalls).toHaveLength(2);
    expect(releaseCalls).toHaveLength(2);
  });

  it("tags the info request with the stream's client id so progress can be pushed back", async () => {
    const fetchMock = await renderAdmin();

    const infoCall = fetchMock.mock.calls.find(
      (c) => c[0] === "/api/v1/release/info"
    );
    expect(infoCall).toBeDefined();
    const clientId = (infoCall?.[1] as { headers: Record<string, string> })
      .headers["x-dispatch-release-client-id"];
    expect(clientId).toBeTruthy();
    expect(lastSource().url).toBe(
      `/api/v1/release/create/stream?clientId=${encodeURIComponent(clientId)}`
    );
  });
});

describe("ReleasesAdmin — recent releases", () => {
  it("promotes a prerelease and flips the row to stable", async () => {
    const promote = vi.fn(() => okJson({}));
    const fetchMock = await renderAdmin({
      "/api/v1/releases": () =>
        okJson({
          releases: [makeRelease({ tag: "v2.0.0-rc.1", isPrerelease: true })],
        }),
      "/api/v1/release/promote": promote,
    });

    const row = (await screen.findByText("v2.0.0-rc.1")).closest("div")!;
    expect(within(row).getByText("pre-release")).toBeTruthy();

    fireEvent.click(within(row).getByRole("button", { name: "Promote" }));
    expect(within(row).getByText("Mark stable + latest?")).toBeTruthy();

    await act(async () => {
      fireEvent.click(within(row).getByRole("button", { name: "Confirm" }));
    });

    expect(promote).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetchMock.mock.calls.find((c) => c[0] === "/api/v1/release/promote")?.[1]
        ?.body ?? "{}") as string
    );
    expect(body).toEqual({ tag: "v2.0.0-rc.1" });
    expect(await within(row).findByText("stable")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Promote" })).toBeNull();
  });

  it("cancelling the promote confirmation leaves the release alone", async () => {
    const promote = vi.fn(() => okJson({}));
    await renderAdmin({
      "/api/v1/releases": () =>
        okJson({
          releases: [makeRelease({ tag: "v2.0.0-rc.1", isPrerelease: true })],
        }),
      "/api/v1/release/promote": promote,
    });

    const row = (await screen.findByText("v2.0.0-rc.1")).closest("div")!;
    fireEvent.click(within(row).getByRole("button", { name: "Promote" }));
    fireEvent.click(within(row).getByRole("button", { name: "Cancel" }));

    expect(promote).not.toHaveBeenCalled();
    expect(within(row).queryByText("Mark stable + latest?")).toBeNull();
  });

  it("reports a failed promotion and keeps the row prerelease", async () => {
    await renderAdmin({
      "/api/v1/releases": () =>
        okJson({
          releases: [makeRelease({ tag: "v2.0.0-rc.1", isPrerelease: true })],
        }),
      "/api/v1/release/promote": () =>
        errJson({ error: "gh failed\nstderr=fatal: not found" }),
    });

    const row = (await screen.findByText("v2.0.0-rc.1")).closest("div")!;
    fireEvent.click(within(row).getByRole("button", { name: "Promote" }));
    await act(async () => {
      fireEvent.click(within(row).getByRole("button", { name: "Confirm" }));
    });

    expect(await screen.findByText("not found")).toBeTruthy();
    expect(within(row).getByText("pre-release")).toBeTruthy();
    // The confirmation collapsed when the request went out, so the operator
    // is offered the button again rather than a stuck "confirm" row.
    expect(within(row).queryByText("Mark stable + latest?")).toBeNull();
    expect(within(row).getByRole("button", { name: "Promote" })).toBeTruthy();
  });

  it("only confirms the release the operator clicked", async () => {
    await renderAdmin({
      "/api/v1/releases": () =>
        okJson({
          releases: [
            makeRelease({ tag: "v2.0.0-rc.2", isPrerelease: true }),
            makeRelease({ tag: "v2.0.0-rc.1", isPrerelease: true }),
          ],
        }),
    });

    const first = (await screen.findByText("v2.0.0-rc.2")).closest("div")!;
    const second = screen.getByText("v2.0.0-rc.1").closest("div")!;
    fireEvent.click(within(first).getByRole("button", { name: "Promote" }));

    expect(within(first).getByText("Mark stable + latest?")).toBeTruthy();
    expect(within(second).queryByText("Mark stable + latest?")).toBeNull();
    expect(
      within(second).getByRole("button", { name: "Promote" })
    ).toBeTruthy();
  });

  it("says so when GitHub returns no releases", async () => {
    await renderAdmin();
    expect(await screen.findByText("No releases found")).toBeTruthy();
  });
});

describe("ReleasesAdmin — creating a release", () => {
  const withUnreleased = {
    "/api/v1/release/info": () =>
      okJson(
        makeInfo({
          unreleasedCount: 2,
          commits: [{ sha: "aaa1111", subject: "a change" }],
        })
      ),
  };

  it("hides the create section when there is nothing to release", async () => {
    await renderAdmin();
    expect(await screen.findByText(/No unreleased commits/)).toBeTruthy();
    expect(screen.queryByText("Create release")).toBeNull();
  });

  it("offers the create buttons when the ref is missing even at a zero count", async () => {
    await renderAdmin({
      "/api/v1/release/info": () => okJson(makeInfo({ refMissing: true })),
    });
    expect(await screen.findByText("Create release")).toBeTruthy();
  });

  it("previews bumped tags from the newest GitHub release, not the deployed tag", async () => {
    await renderAdmin({
      ...withUnreleased,
      "/api/v1/releases": () =>
        okJson({ releases: [makeRelease({ tag: "v1.4.0" })] }),
    });

    await screen.findByText("Create release");
    expect(screen.getByText("v1.4.1")).toBeTruthy();
    expect(screen.getByText("v1.5.0")).toBeTruthy();
    expect(screen.getByText("v2.0.0")).toBeTruthy();
    // v1.2.3 is info.currentTag — the fallback, which must lose here.
    expect(screen.queryByText("v1.2.4")).toBeNull();
  });

  it("falls back to the deployed tag when GitHub has no releases", async () => {
    await renderAdmin(withUnreleased);
    await screen.findByText("Create release");
    expect(screen.getByText("v1.2.4")).toBeTruthy();
  });

  it("confirms, posts the version type, and takes over with the progress view", async () => {
    const fetchMock = await renderAdmin({
      ...withUnreleased,
      "/api/v1/release": () => okJson({}),
    });

    await screen.findByText("Create release");
    fireEvent.click(screen.getByRole("button", { name: /minor/i }));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/triggers the release workflow/)
    ).toBeTruthy();

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Release" }));
    });

    const post = fetchMock.mock.calls.find((c) => c[0] === "/api/v1/release");
    expect(post?.[1]?.method).toBe("POST");
    expect(JSON.parse(post?.[1]?.body as string)).toEqual({
      versionType: "minor",
    });

    // The optimistic job switches the page into the takeover.
    expect(
      await screen.findByRole("button", { name: /Back to releases/ })
    ).toBeTruthy();
    expect(screen.queryByText("Recent releases")).toBeNull();
  });

  it("cancelling the confirmation posts nothing", async () => {
    const fetchMock = await renderAdmin({
      ...withUnreleased,
      "/api/v1/release": () => okJson({}),
    });

    await screen.findByText("Create release");
    fireEvent.click(screen.getByRole("button", { name: /patch/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fetchMock.mock.calls.some((c) => c[0] === "/api/v1/release")).toBe(
      false
    );
  });

  it("shows a rejected release request and stays on the releases page", async () => {
    await renderAdmin({
      ...withUnreleased,
      "/api/v1/release": () =>
        errJson({ error: "workflow failed\nstderr=fatal: dirty tree" }),
    });

    await screen.findByText("Create release");
    fireEvent.click(screen.getByRole("button", { name: /patch/i }));
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Release" }));
    });

    expect(await screen.findByText("dirty tree")).toBeTruthy();
    expect(screen.getByText("Recent releases")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Back to releases/ })
    ).toBeNull();
  });
});

describe("ReleasesAdmin — in-flight job banners", () => {
  async function renderWithJob(
    job: Partial<CreateJobShape>,
    routes: Record<string, Handler> = {}
  ) {
    const fetchMock = await renderAdmin(routes);
    await act(async () => {
      lastSource().emit({ type: "snapshot", job: makeCreateJob(job) });
    });
    return fetchMock;
  }

  it("shows the running release and opens the progress view on demand", async () => {
    await renderWithJob({ phase: "watching", tag: "v1.2.4" });

    const banner = screen.getByText(/Releasing/);
    expect(banner.textContent).toContain("patch");
    expect(banner.textContent).toContain("v1.2.4");
    expect(banner.textContent).toContain("watching");

    fireEvent.click(screen.getByRole("button", { name: "View progress" }));
    expect(
      screen.getByRole("button", { name: /Back to releases/ })
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Back to releases/ }));
    expect(screen.getByText(/Releasing/)).toBeTruthy();
    expect(screen.getByText("Recent releases")).toBeTruthy();
  });

  it("cleans up a failed release's error and dismisses the whole job", async () => {
    await renderWithJob({
      phase: "failed",
      error: "workflow blew up\nstderr=fatal: no runner",
    });

    expect(screen.getByText(/Release failed: no runner/)).toBeTruthy();
    // A failed release is finished, so it must not also read as running.
    expect(screen.queryByText(/Releasing/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/Release failed/)).toBeNull();
  });

  it("ignores a job that is not a release-create job", async () => {
    await renderAdmin();
    await act(async () => {
      lastSource().emit({
        type: "snapshot",
        job: {
          ...makeCreateJob(),
          jobType: "update",
          versionType: null,
          phase: "fetching",
        },
      });
    });

    // The create page drives OperationTakeover with CREATE_PHASES; an update
    // job reaching it would be rendered against the wrong phase list.
    expect(screen.queryByText(/Releasing/)).toBeNull();
    expect(screen.getByText("Recent releases")).toBeTruthy();
  });

  it("does not claim a release finished when it only saw a stale done snapshot", async () => {
    await renderWithJob({ phase: "done", tag: "v1.2.4" });

    expect(screen.queryByText(/^Released$/)).toBeNull();
  });

  it("announces the tag and refreshes once when a watched release finishes", async () => {
    const fetchMock = await renderWithJob({ phase: "watching" });

    const infoBefore = fetchMock.mock.calls.filter(
      (c) => c[0] === "/api/v1/release/info"
    ).length;

    await act(async () => {
      lastSource().emit({
        type: "snapshot",
        job: makeCreateJob({ phase: "done", tag: "v1.2.4" }),
      });
    });

    const done = screen.getByText("Released").parentElement!;
    expect(within(done).getByText("v1.2.4")).toBeTruthy();
    expect(
      fetchMock.mock.calls.filter((c) => c[0] === "/api/v1/release/info").length
    ).toBe(infoBefore + 1);

    // A repeat snapshot for the same run must not refetch again.
    await act(async () => {
      lastSource().emit({
        type: "snapshot",
        job: makeCreateJob({ phase: "done", tag: "v1.2.4" }),
      });
    });
    expect(
      fetchMock.mock.calls.filter((c) => c[0] === "/api/v1/release/info").length
    ).toBe(infoBefore + 1);
  });

  it("stays quiet about a release that finishes after the banner was dismissed", async () => {
    await renderWithJob({ phase: "watching", tag: "v1.2.4" });
    await act(async () => {
      lastSource().emit({
        type: "snapshot",
        job: makeCreateJob({ phase: "done", tag: "v1.2.4" }),
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Released")).toBeNull();

    await act(async () => {
      lastSource().emit({
        type: "snapshot",
        job: makeCreateJob({
          phase: "done",
          tag: "v1.2.5",
          startedAt: "2026-08-01T13:00:00.000Z",
        }),
      });
    });
    // Dismiss cleared watchedRelease, so a done job arriving cold stays quiet.
    expect(screen.queryByText("Released")).toBeNull();
  });

  it("blocks a second release while one is in flight", async () => {
    await renderWithJob(
      { phase: "watching" },
      {
        "/api/v1/release/info": () =>
          okJson(
            makeInfo({
              unreleasedCount: 2,
              commits: [{ sha: "aaa1111", subject: "a change" }],
            })
          ),
      }
    );

    const patch = screen.getByRole("button", { name: /patch/i });
    expect((patch as HTMLButtonElement).disabled).toBe(true);
  });
});
