// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AssistedUpdateState } from "../../../server/src/assisted-update-store";

import {
  applyStreamEvent,
  useReleaseStream,
  type ReleaseJob,
  type ReleaseProgress,
} from "./use-release-stream";

vi.mock("@/lib/pwa-update", () => ({ reloadApp: vi.fn() }));
vi.mock("@/lib/version", () => ({ noteServerVersion: vi.fn() }));
vi.mock("@/lib/energy-metrics", () => ({
  recordReleaseManagerPollFire: vi.fn(),
}));

import { reloadApp } from "@/lib/pwa-update";

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

const commonFields = {
  startedAt: "2026-08-02T00:00:00.000Z",
  log: ["one", "two", "three"],
  runUrl: null,
  tag: null,
  error: null,
  progress: null,
};

function updateJob(overrides: Partial<ReleaseJob> = {}): ReleaseJob {
  return {
    ...commonFields,
    jobType: "update",
    versionType: null,
    phase: "fetching",
    ...overrides,
  } as ReleaseJob;
}

function createJob(overrides: Partial<ReleaseJob> = {}): ReleaseJob {
  return {
    ...commonFields,
    jobType: "create",
    versionType: "patch",
    phase: "preflight",
    ...overrides,
  } as ReleaseJob;
}

function assistedState(
  overrides: Partial<AssistedUpdateState> = {}
): AssistedUpdateState {
  return {
    tag: "v1.2.3",
    fromTag: "v1.2.2",
    metadata: null,
    migrations: null,
    requiredChecks: [],
    phase: "inspect",
    token: "tok",
    agentId: null,
    startedAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    completedAt: null,
    error: null,
    checks: [],
    notes: {},
    ...overrides,
  };
}

function assistedJob(overrides: Partial<ReleaseJob> = {}): ReleaseJob {
  return {
    ...commonFields,
    jobType: "update-assisted",
    versionType: null,
    phase: "inspect",
    assisted: assistedState(),
    ...overrides,
  } as ReleaseJob;
}

const progress: ReleaseProgress = {
  step: "download",
  label: "Downloading",
  detail: null,
  bytesReceived: 10,
  totalBytes: 100,
};

describe("applyStreamEvent", () => {
  it("ignores events when no job is in flight", () => {
    expect(applyStreamEvent(null, { type: "log", line: "x" })).toBeNull();
  });

  it("log appends the line without mutating the previous job", () => {
    const prev = updateJob({ log: ["a"] });
    const next = applyStreamEvent(prev, { type: "log", line: "b" });
    expect(next?.log).toEqual(["a", "b"]);
    expect(prev.log).toEqual(["a"]);
    expect(next).not.toBe(prev);
  });

  it("log.rewind drops exactly the last count entries", () => {
    const prev = updateJob({ log: ["a", "b", "c"] });
    expect(
      applyStreamEvent(prev, { type: "log.rewind", count: 2 })?.log
    ).toEqual(["a"]);
    expect(
      applyStreamEvent(prev, { type: "log.rewind", count: 3 })?.log
    ).toEqual([]);
  });

  it("log.replace swaps only the last line", () => {
    const prev = updateJob({ log: ["a", "b"] });
    expect(
      applyStreamEvent(prev, { type: "log.replace", line: "B" })?.log
    ).toEqual(["a", "B"]);
  });

  it("log.replace pushes onto an empty log", () => {
    const prev = updateJob({ log: [] });
    expect(
      applyStreamEvent(prev, { type: "log.replace", line: "first" })?.log
    ).toEqual(["first"]);
  });

  it.each([
    ["create", createJob(), "watching"],
    ["update", updateJob(), "deploying"],
    ["update-assisted", assistedJob(), "apply"],
  ] as const)("phase updates the %s job's phase", (_jobType, prev, phase) => {
    const next = applyStreamEvent(prev, { type: "phase", phase });
    expect(next?.phase).toBe(phase);
  });

  it("phase keeps the previous error when the event carries none", () => {
    const prev = updateJob({ error: "boom" });
    const next = applyStreamEvent(prev, {
      type: "phase",
      phase: "deploying",
    });
    expect(next?.error).toBe("boom");
  });

  it("phase overwrites the error when the event carries one", () => {
    const prev = updateJob({ error: "boom" });
    const next = applyStreamEvent(prev, {
      type: "phase",
      phase: "failed",
      error: "worse",
    });
    expect(next?.error).toBe("worse");
  });

  it("progress replaces the progress payload and null clears it", () => {
    const prev = updateJob({ progress });
    const cleared = applyStreamEvent(prev, {
      type: "progress",
      progress: null,
    });
    expect(cleared?.progress).toBeNull();
    const set = applyStreamEvent(updateJob(), { type: "progress", progress });
    expect(set?.progress).toEqual(progress);
  });

  it("runUrl and tag set their fields", () => {
    expect(
      applyStreamEvent(updateJob(), { type: "runUrl", url: "https://x" })
        ?.runUrl
    ).toBe("https://x");
    expect(
      applyStreamEvent(updateJob(), { type: "tag", tag: "v2.0.0" })?.tag
    ).toBe("v2.0.0");
  });

  it("assisted is ignored for jobs that are not update-assisted", () => {
    const prev = updateJob();
    const next = applyStreamEvent(prev, {
      type: "assisted",
      state: assistedState(),
    });
    expect(next).toBe(prev);
  });

  it("assisted replaces the state on update-assisted jobs", () => {
    const state = assistedState({ phase: "validate" });
    const next = applyStreamEvent(assistedJob(), { type: "assisted", state });
    expect(next).toMatchObject({ assisted: state });
  });
});

describe("useReleaseStream", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      headers: { get: () => null },
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  function lastSource(): FakeEventSource {
    const source = FakeEventSource.instances.at(-1);
    if (!source) throw new Error("no EventSource was created");
    return source;
  }

  it("connects with the stable client id and applies stream events to the job", () => {
    const { result } = renderHook(() => useReleaseStream("update"));

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(lastSource().url).toBe(
      `/api/v1/release/update/stream?clientId=${encodeURIComponent(result.current.streamClientId)}`
    );

    // Events that arrive before a snapshot must be no-ops.
    act(() => lastSource().emit({ type: "log", line: "early" }));
    expect(result.current.job).toBeNull();

    act(() =>
      lastSource().emit({ type: "snapshot", job: updateJob({ log: ["a"] }) })
    );
    act(() => lastSource().emit({ type: "log", line: "b" }));
    expect(result.current.job?.log).toEqual(["a", "b"]);
  });

  it("routes info-progress to infoProgress without touching the job", () => {
    const { result } = renderHook(() => useReleaseStream("update"));

    act(() => lastSource().emit({ type: "info-progress", progress }));
    expect(result.current.infoProgress).toEqual(progress);
    expect(result.current.job).toBeNull();
  });

  it("connectStream closes the previous stream and reuses the client id", () => {
    const { result } = renderHook(() => useReleaseStream("update"));
    const first = lastSource();

    act(() => result.current.connectStream());

    expect(first.close).toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(lastSource().url).toBe(first.url);
  });

  it("stream error during an update deploy polls health and finishes on the new tag", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useReleaseStream("update"));
    const source = lastSource();

    act(() =>
      source.emit({
        type: "snapshot",
        job: updateJob({ phase: "deploying", tag: "v9.9.9" }),
      })
    );

    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => "9.9.9" },
      json: async () => ({ tag: "v9.9.9", deployedAt: "2026-08-02T00:00:00Z" }),
    });

    act(() => source.onerror?.());
    expect(result.current.job?.phase).toBe("restarting");
    expect(result.current.postRestartPolling).toBe(true);
    expect(source.close).toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.postRestartPolling).toBe(false);
    expect(result.current.status).toEqual({
      tag: "v9.9.9",
      deployedAt: "2026-08-02T00:00:00Z",
    });
    expect(result.current.job).toMatchObject({ phase: "done", tag: "v9.9.9" });

    expect(reloadApp).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(reloadApp).toHaveBeenCalledTimes(1);
  });

  it("keeps polling while the server still reports the old tag", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useReleaseStream("update"));
    const source = lastSource();

    act(() =>
      source.emit({
        type: "snapshot",
        job: updateJob({ phase: "restarting", tag: "v9.9.9" }),
      })
    );

    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => "9.9.8" },
      json: async () => ({ tag: "v9.9.8", deployedAt: "2026-08-01T00:00:00Z" }),
    });

    act(() => source.onerror?.());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(result.current.postRestartPolling).toBe(true);
    expect(result.current.job?.phase).toBe("restarting");
    expect(reloadApp).not.toHaveBeenCalled();
  });

  it.each([
    ["create", createJob({ phase: "watching" }), "watching"],
    // An assisted job can sit in "restarting" too — only plain update
    // jobs may hand off to the health poll.
    ["update-assisted", assistedJob({ phase: "restarting" }), "restarting"],
    // An update job outside deploying/restarting must not poll either.
    ["update", updateJob({ phase: "fetching" }), "fetching"],
  ] as const)("stream error leaves %s jobs alone", (jobType, job, phase) => {
    const { result } = renderHook(() =>
      useReleaseStream(jobType === "create" ? "create" : "update")
    );
    const source = lastSource();

    act(() => source.emit({ type: "snapshot", job }));
    act(() => source.onerror?.());

    expect(result.current.job).toMatchObject({ jobType, phase });
    expect(result.current.postRestartPolling).toBe(false);
    expect(source.close).toHaveBeenCalled();
  });

  it("unmount closes the stream and stops the health poll", async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useReleaseStream("update"));
    const source = lastSource();

    act(() =>
      source.emit({
        type: "snapshot",
        job: updateJob({ phase: "restarting", tag: "v9.9.9" }),
      })
    );
    act(() => source.onerror?.());

    const callsAtUnmount = fetchMock.mock.calls.length;
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    expect(source.close).toHaveBeenCalled();
    expect(fetchMock.mock.calls.length).toBe(callsAtUnmount);
  });
});
