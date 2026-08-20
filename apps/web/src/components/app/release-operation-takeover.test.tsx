// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReleaseJob } from "@/hooks/use-release-stream";

import { OperationTakeover } from "./release-operation-takeover";
import { UPDATE_PHASES } from "./release-utils";

type UpdateJob = Extract<ReleaseJob, { jobType: "update" }>;
type CreateJob = Extract<ReleaseJob, { jobType: "create" }>;

function makeJob(overrides: Partial<UpdateJob> = {}): UpdateJob {
  return {
    jobType: "update",
    phase: "fetching",
    startedAt: "2026-08-01T12:00:00.000Z",
    log: ["fetching v1.1.0"],
    runUrl: null,
    tag: "v1.1.0",
    error: null,
    progress: null,
    versionType: null,
    ...overrides,
  } as UpdateJob;
}

/** The release half of the union — the takeover serves both job types. */
function makeCreateJob(overrides: Partial<CreateJob> = {}): CreateJob {
  const { jobType: _jobType, versionType: _versionType, ...common } = makeJob();
  return {
    ...common,
    jobType: "create",
    versionType: "patch",
    phase: "preflight",
    ...overrides,
  };
}

type RenderOverrides = {
  job?: ReleaseJob;
  phasesOrder?: string[];
  isDone?: boolean;
  isFailed?: boolean;
  isRestarting?: boolean;
  postRestartPolling?: boolean;
  status?: { tag: string | null; deployedAt: string | null } | null;
};

function renderTakeover(overrides: RenderOverrides = {}): {
  onDismiss: ReturnType<typeof vi.fn>;
  container: HTMLElement;
} {
  const onDismiss = vi.fn();
  const { container } = render(
    <OperationTakeover
      job={overrides.job ?? makeJob()}
      phasesOrder={overrides.phasesOrder ?? [...UPDATE_PHASES]}
      isDone={overrides.isDone ?? false}
      isFailed={overrides.isFailed ?? false}
      isRestarting={overrides.isRestarting ?? false}
      postRestartPolling={overrides.postRestartPolling ?? false}
      status={
        overrides.status === undefined
          ? { tag: "v1.0.0", deployedAt: null }
          : overrides.status
      }
      onDismiss={onDismiss}
    />
  );
  return { onDismiss, container };
}

afterEach(() => {
  cleanup();
});

describe("the current step card", () => {
  it("stays hidden until the job reports progress", () => {
    renderTakeover({ job: makeJob({ progress: null }) });

    expect(screen.queryByText("Current step")).toBeNull();
  });

  it("shows the label, its detail, and the transferred byte count", () => {
    renderTakeover({
      job: makeJob({
        progress: {
          step: "download",
          label: "Downloading release",
          detail: "dispatch-release.tar.gz",
          bytesReceived: 512 * 1024,
          totalBytes: 1024 * 1024,
        },
      }),
    });

    expect(screen.getByText("Current step")).toBeTruthy();
    expect(screen.getByText("Downloading release")).toBeTruthy();
    expect(screen.getByText("dispatch-release.tar.gz")).toBeTruthy();
    expect(screen.getByText("50% · 512 KB / 1.0 MB")).toBeTruthy();
  });

  // The bar is the one part of the progress card with no text of its own, so
  // its width is the only thing that can report an overshooting byte count —
  // and an unclamped width paints the fill straight out of its track.
  it("clamps the progress bar when more bytes arrive than were announced", () => {
    const { container } = renderTakeover({
      job: makeJob({
        progress: {
          step: "download",
          label: "Downloading release",
          detail: null,
          bytesReceived: 3 * 1024 * 1024,
          totalBytes: 2 * 1024 * 1024,
        },
      }),
    });

    const bar = container.querySelector("div[style]");
    expect(bar?.getAttribute("style")).toBe("width: 100%;");
  });

  it("omits the byte readout for a step that transfers nothing", () => {
    renderTakeover({
      job: makeJob({
        progress: {
          step: "download",
          label: "Swapping the symlink",
          detail: null,
          bytesReceived: null,
          totalBytes: null,
        },
      }),
    });

    expect(screen.getByText("Swapping the symlink")).toBeTruthy();
    // Match the readout itself, not its separator: a lost null guard in
    // formatProgressLabel renders a bare "0 B downloaded" with no separator.
    expect(screen.queryByText(/\d+(\.\d+)?\s?(B|KB|MB|GB)/)).toBeNull();
  });
});

describe("the phase walk", () => {
  // Read as one string so the ORDER is pinned, not just the membership —
  // every phase ahead of the current one is drawn as already complete.
  it("walks the standard update phases in order and drops the terminal one", () => {
    renderTakeover({ job: makeJob({ phase: "deploying" }) });

    const column = screen.getByText("Progress").parentElement;
    expect(column?.textContent).toBe("ProgressFetchingDeployingRestarting");
  });

  it("spins on the restart row only while the restart is under way", () => {
    renderTakeover({
      job: makeJob({ phase: "restarting" }),
      isRestarting: true,
    });
    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();

    cleanup();
    renderTakeover({
      job: makeJob({ phase: "restarting" }),
      isRestarting: false,
    });
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
  });

  // useReleaseUpdates raises isRestarting for any update job once the client
  // starts polling for the server to come back, so it can be true while the
  // job is still deploying — the restart row must not claim to be running.
  it("leaves the restart row idle while an earlier phase is current", () => {
    renderTakeover({
      job: makeJob({ phase: "deploying" }),
      isRestarting: true,
      postRestartPolling: true,
    });

    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
  });
});

describe("the operation log", () => {
  it("hides the restart sentinel and renders the surrounding lines", () => {
    renderTakeover({
      job: makeJob({
        // The sentinel reaches the client padded by the stream framing, so
        // it has to be matched after trimming, not by exact equality.
        log: ["fetching v1.1.0", "  DISPATCH_RESTARTING  ", "deployed"],
      }),
    });

    expect(screen.getByText("fetching v1.1.0")).toBeTruthy();
    expect(screen.getByText("deployed")).toBeTruthy();
    expect(screen.queryByText("DISPATCH_RESTARTING")).toBeNull();
  });

  it("explains the silence while the server is still coming back", () => {
    renderTakeover({
      job: makeJob({ log: [] }),
      isRestarting: false,
      postRestartPolling: true,
    });

    expect(screen.getByText("Waiting for Dispatch to restart...")).toBeTruthy();
  });

  it("drops the placeholder once the restarted server streams again", () => {
    renderTakeover({
      job: makeJob({ log: ["back up"] }),
      isRestarting: true,
      postRestartPolling: true,
    });

    expect(screen.queryByText("Waiting for Dispatch to restart...")).toBeNull();
    expect(screen.getByText("back up")).toBeTruthy();
  });
});

describe("the outcome banners", () => {
  it("links the GitHub Actions run when the job recorded one", () => {
    renderTakeover({
      job: makeJob({ runUrl: "https://example.test/runs/1" }),
    });

    const link = screen.getByRole("link", { name: /View GitHub Actions run/ });
    expect(link.getAttribute("href")).toBe("https://example.test/runs/1");
    // An operator-followed link out of the app has to open a new tab, or the
    // in-flight takeover is navigated away from.
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("offers no run link for a job that never triggered a workflow", () => {
    renderTakeover({ job: makeJob({ runUrl: null }) });

    expect(
      screen.queryByRole("link", { name: /View GitHub Actions run/ })
    ).toBeNull();
  });

  it("says Updated to for a finished update and dismisses on Done", () => {
    const { onDismiss } = renderTakeover({
      job: makeJob({ phase: "done", tag: "v1.1.0" }),
      isDone: true,
    });

    expect(screen.getByText("Updated to")).toBeTruthy();
    expect(screen.getByText("v1.1.0")).toBeTruthy();
    expect(screen.queryByText("Released")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("says Released for a finished release job", () => {
    renderTakeover({
      job: makeCreateJob({ phase: "done", tag: "v1.1.0" }),
      isDone: true,
    });

    expect(screen.getByText("Released")).toBeTruthy();
    expect(screen.queryByText("Updated to")).toBeNull();
  });

  it("falls back to the deployed status tag when the job carries none", () => {
    renderTakeover({
      job: makeJob({ phase: "done", tag: null }),
      isDone: true,
      status: { tag: "v1.0.9", deployedAt: null },
    });

    expect(screen.getByText("v1.0.9")).toBeTruthy();
  });

  it("strips the git plumbing off a failure and dismisses on Dismiss", () => {
    const { onDismiss } = renderTakeover({
      job: makeJob({
        phase: "failed",
        error:
          "Command failed (git fetch), exitCode=128, stderr=fatal: could not resolve host",
      }),
      isFailed: true,
    });

    expect(screen.getByText("could not resolve host")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("names an unexplained failure rather than showing an empty banner", () => {
    renderTakeover({
      job: makeJob({ phase: "failed", error: null }),
      isFailed: true,
    });

    expect(screen.getByText("Operation failed")).toBeTruthy();
  });

  it("shows no banner and no dismissal while the operation runs", () => {
    renderTakeover({ job: makeJob({ phase: "fetching" }) });

    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });
});
