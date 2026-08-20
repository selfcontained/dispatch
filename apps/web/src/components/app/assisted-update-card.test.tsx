// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AssistedCheckResult,
  AssistedUpdateMetadata,
  AssistedUpdateState,
  ReleaseJob,
  UpdateMigrationManifest,
} from "@/hooks/use-release-stream";

import {
  AssistedUpdateGate,
  AssistedUpdateProgress,
  PendingMigrationsGate,
} from "./assisted-update-card";

// Markdown pulls in react-markdown and lazily boots mermaid off a live
// CSSStyleDeclaration; the gates only use it as a body renderer, and the
// behaviour under test is the disclosure toggle around it.
vi.mock("@/components/ui/markdown", () => ({
  Markdown: ({ children }: { children: string }) => <div>{children}</div>,
}));

type AssistedJob = Extract<ReleaseJob, { jobType: "update-assisted" }>;

function makeManifest(
  overrides: Partial<UpdateMigrationManifest> = {}
): UpdateMigrationManifest {
  return {
    id: "0001-bun-cutover",
    title: "Cut over to bun",
    summary: "Swaps the runtime.",
    alreadySatisfied: { description: "bun is on PATH" },
    instructions: ["install bun"],
    validation: { requiredChecks: [] },
    rollback: [],
    ...overrides,
  };
}

function makeAssistedState(
  overrides: Partial<AssistedUpdateState> = {}
): AssistedUpdateState {
  return {
    tag: "v1.1.0",
    fromTag: "v1.0.0",
    metadata: null,
    migrations: null,
    requiredChecks: [],
    phase: "apply",
    token: "tok",
    agentId: null,
    startedAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
    completedAt: null,
    error: null,
    checks: [],
    notes: {},
    ...overrides,
  };
}

function makeJob(
  assisted: Partial<AssistedUpdateState> = {},
  overrides: Partial<AssistedJob> = {}
): AssistedJob {
  const state = makeAssistedState(assisted);
  return {
    jobType: "update-assisted",
    startedAt: "2026-08-01T12:00:00.000Z",
    log: [],
    runUrl: null,
    tag: "v1.1.0",
    error: null,
    progress: null,
    versionType: null,
    phase: state.phase,
    assisted: state,
    ...overrides,
  } as AssistedJob;
}

function renderProgress(job: AssistedJob): {
  onDismiss: ReturnType<typeof vi.fn>;
} {
  const onDismiss = vi.fn();
  render(<AssistedUpdateProgress job={job} onDismiss={onDismiss} />);
  return { onDismiss };
}

afterEach(() => {
  cleanup();
});

describe("the assisted takeover headline", () => {
  // A run driven by migration manifests and a run driven by legacy release
  // metadata are mutually exclusive on the server, but the state carries both
  // fields — the card has to say which one is actually driving this run.
  it("describes the snapshotted migrations rather than the release metadata", () => {
    renderProgress(
      makeJob({
        metadata: {
          mode: "required",
          title: "Service manager rewrite",
          summary: "The launchd plist changes shape.",
          requiredChecks: [],
        } as AssistedUpdateMetadata,
        migrations: [
          makeManifest({ id: "0001", title: "Move the socket" }),
          makeManifest({ id: "0002", title: "Rewrite the plist" }),
        ],
      })
    );

    expect(screen.getByText("2 migrations pending")).toBeTruthy();
    expect(
      screen.getByText("Move the socket → Rewrite the plist")
    ).toBeTruthy();
    expect(screen.queryByText("Service manager rewrite")).toBeNull();
  });

  it("says migration, singular, for a one-manifest run", () => {
    renderProgress(
      makeJob({ migrations: [makeManifest({ title: "Move the socket" })] })
    );

    expect(screen.getByText("1 migration pending")).toBeTruthy();
  });

  it("falls back to the release metadata when no manifest drives the run", () => {
    renderProgress(
      makeJob({
        // An empty array is the same "no manifests" signal as null and must
        // not produce a "0 migrations pending" headline.
        migrations: [],
        metadata: {
          mode: "required",
          title: "Service manager rewrite",
          summary: "The launchd plist changes shape.",
          requiredChecks: [],
        } as AssistedUpdateMetadata,
      })
    );

    expect(screen.getByText("Service manager rewrite")).toBeTruthy();
    expect(screen.getByText("The launchd plist changes shape.")).toBeTruthy();
    expect(screen.queryByText("0 migrations pending")).toBeNull();
  });

  it("names the run generically when neither source is present", () => {
    renderProgress(makeJob({ migrations: null, metadata: null }));

    // "Assisted update" is also the static section label above the headline,
    // so the fallback is what makes the phrase appear a second time.
    expect(screen.getAllByText("Assisted update")).toHaveLength(2);
  });
});

describe("the assisted phase walk", () => {
  // Reading the whole column as text rather than asserting each label is
  // present is what pins the ORDER: the walk marks every phase before the
  // current one as complete, so a reordered list silently reports the wrong
  // steps as already done.
  it("walks the assisted phases in order and not the standard release ones", () => {
    renderProgress(makeJob({ phase: "apply" }, { phase: "apply" }));

    const column = screen.getByText("Progress").parentElement;
    expect(column?.textContent).toBe(
      // `done` is the terminal marker, not a step the operator waits through.
      "ProgressInspect installPrepare migrationApply updateRestartingValidate checks"
    );
  });

  // A non-empty log keeps the log pane's own "waiting for restart" spinner
  // out of the way, so the only spinner left is the one on the phase row.
  it("spins only while the restart phase is the current one", () => {
    renderProgress(
      makeJob(
        { phase: "restarting" },
        { phase: "restarting", log: ["applied"] }
      )
    );
    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();

    cleanup();
    renderProgress(
      makeJob({ phase: "apply" }, { phase: "apply", log: ["applied"] })
    );
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
  });
});

describe("the assisted takeover detail lists", () => {
  it("numbers each migration against the total", () => {
    renderProgress(
      makeJob({
        migrations: [
          makeManifest({ id: "0001-socket", title: "Move the socket" }),
          makeManifest({ id: "0002-plist", title: "Rewrite the plist" }),
        ],
      })
    );

    expect(screen.getByText("1/2")).toBeTruthy();
    expect(screen.getByText("2/2")).toBeTruthy();
    expect(screen.getByText("0001-socket")).toBeTruthy();
    expect(screen.getByText("0002-plist")).toBeTruthy();
  });

  it("attributes each agent note to the phase that produced it", () => {
    renderProgress(
      makeJob({
        notes: {
          inspect: "launchd plist is the old shape",
          apply: "rewrote the plist",
        } as AssistedUpdateState["notes"],
      })
    );

    expect(screen.getByText("Agent notes")).toBeTruthy();
    expect(screen.getByText("inspect")).toBeTruthy();
    expect(screen.getByText("launchd plist is the old shape")).toBeTruthy();
    expect(screen.getByText("apply")).toBeTruthy();
    expect(screen.getByText("rewrote the plist")).toBeTruthy();
  });

  it("omits the notes and checks sections when the agent reported neither", () => {
    renderProgress(makeJob());

    expect(screen.queryByText("Agent notes")).toBeNull();
    expect(screen.queryByText("Required checks")).toBeNull();
    expect(screen.queryByText("Migrations")).toBeNull();
  });

  it("reports the message of every required check, passing or not", () => {
    const checks: AssistedCheckResult[] = [
      { name: "server_responds", ok: true, message: "200 from /health" },
      { name: "plist_shape", ok: false, message: "still the old shape" },
    ];
    renderProgress(makeJob({ checks }));

    expect(screen.getByText("server_responds")).toBeTruthy();
    expect(screen.getByText("200 from /health")).toBeTruthy();
    expect(screen.getByText("plist_shape")).toBeTruthy();
    expect(screen.getByText("still the old shape")).toBeTruthy();
  });

  it("links the launched update agent by its id", () => {
    renderProgress(makeJob({ agentId: "agt_0123456789abcdef" }));

    const link = screen.getByRole("link", { name: /View update agent/ });
    expect(link.getAttribute("href")).toBe("/agents/agt_0123456789abcdef");
    // The id is truncated for the row; the full id has to stay in the href
    // or the link lands on a different agent.
    expect(screen.getByText("agt_01234567")).toBeTruthy();
  });

  it("offers no agent link before one has been launched", () => {
    renderProgress(makeJob({ agentId: null }));

    expect(
      screen.queryByRole("link", { name: /View update agent/ })
    ).toBeNull();
  });
});

describe("the assisted takeover outcome", () => {
  it("confirms the installed tag and dismisses on Done", () => {
    const { onDismiss } = renderProgress(
      makeJob({ phase: "done" }, { phase: "done", tag: "v1.2.0" })
    );

    expect(screen.getByText("Updated to")).toBeTruthy();
    expect(screen.getByText("v1.2.0")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["failed" as const, "Update failed"],
    ["rollback" as const, "Update rolled back"],
    ["blocked" as const, "Update blocked — required checks did not pass"],
  ])("names the %s outcome and dismisses", (phase, headline) => {
    const { onDismiss } = renderProgress(
      makeJob({ phase }, { phase, error: "job-level error" })
    );

    expect(screen.getByText(headline)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("prefers the assisted run's error over the job-level one", () => {
    renderProgress(
      makeJob(
        { phase: "failed", error: "check plist_shape failed" },
        { phase: "failed", error: "tarball fetch failed" }
      )
    );

    expect(screen.getByText("check plist_shape failed")).toBeTruthy();
    expect(screen.queryByText("tarball fetch failed")).toBeNull();
  });

  it("falls back to the job error when the run recorded none", () => {
    renderProgress(
      makeJob(
        { phase: "failed", error: null },
        { phase: "failed", error: "tarball fetch failed" }
      )
    );

    expect(screen.getByText("tarball fetch failed")).toBeTruthy();
  });

  it("shows no outcome banner while the update is still running", () => {
    renderProgress(makeJob({ phase: "apply" }, { phase: "apply" }));

    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("keeps the restart sentinel out of the streamed log", () => {
    renderProgress(
      makeJob(
        {},
        {
          log: [
            "fetching v1.1.0",
            // Padded by the stream framing — matched after trimming.
            "  DISPATCH_RESTARTING  ",
            "  ",
            "applied",
          ],
        }
      )
    );

    expect(screen.getByText("fetching v1.1.0")).toBeTruthy();
    expect(screen.getByText("applied")).toBeTruthy();
    expect(screen.queryByText("DISPATCH_RESTARTING")).toBeNull();
  });
});

describe("the pre-launch gates", () => {
  it("counts the pending update steps", () => {
    render(
      <PendingMigrationsGate
        tag="v1.1.0"
        pendingMigrations={[
          { id: "0001", title: "Move the socket", summary: "Relocates it." },
          { id: "0002", title: "Rewrite the plist", summary: "New shape." },
        ]}
      />
    );

    expect(screen.getByText("2 complex update steps")).toBeTruthy();
    expect(screen.getByText("Move the socket")).toBeTruthy();
    expect(screen.getByText("Relocates it.")).toBeTruthy();
    expect(screen.getByText("v1.1.0")).toBeTruthy();
  });

  it("says step, singular, for one pending migration", () => {
    render(
      <PendingMigrationsGate
        tag="v1.1.0"
        pendingMigrations={[
          { id: "0001", title: "Move the socket", summary: "Relocates it." },
        ]}
      />
    );

    expect(screen.getByText("1 complex update step")).toBeTruthy();
  });

  // `required` is NOT metadata.mode — release-info raises assistedRequired for
  // pending migrations and for an unevaluable migration set too, so a
  // mode="required" release can still be offered as merely recommended. Holding
  // the mode fixed is what proves the prop, not the metadata, drives the copy.
  it("takes the required/recommended split from the prop, not the mode", () => {
    const metadata: AssistedUpdateMetadata = {
      mode: "required",
      title: "Service manager rewrite",
      summary: "The launchd plist changes shape.",
      requiredChecks: [],
    };
    const { unmount } = render(
      <AssistedUpdateGate tag="v1.1.0" metadata={metadata} required />
    );
    expect(screen.getByText("Agent-assisted update required")).toBeTruthy();

    unmount();
    render(
      <AssistedUpdateGate tag="v1.1.0" metadata={metadata} required={false} />
    );
    expect(screen.getByText("Agent-assisted update recommended")).toBeTruthy();
    expect(screen.queryByText("Agent-assisted update required")).toBeNull();
  });

  it("accepts required checks named as bare strings or as objects", () => {
    render(
      <AssistedUpdateGate
        tag="v1.1.0"
        required
        metadata={
          {
            mode: "required",
            title: "Service manager rewrite",
            summary: "The launchd plist changes shape.",
            requiredChecks: [
              "server_responds",
              { name: "plist_shape", description: "plist is the new shape" },
            ],
          } as unknown as AssistedUpdateMetadata
        }
      />
    );

    expect(screen.getByText("server_responds")).toBeTruthy();
    expect(screen.getByText("plist_shape")).toBeTruthy();
  });

  it("opens the instructions and keeps rollback guidance folded away", () => {
    render(
      <AssistedUpdateGate
        tag="v1.1.0"
        required
        metadata={
          {
            mode: "required",
            title: "Service manager rewrite",
            summary: "The launchd plist changes shape.",
            requiredChecks: [],
            instructions: "Run the installer, then restart.",
            rollbackGuidance: "Reinstall the previous tarball.",
          } as unknown as AssistedUpdateMetadata
        }
      />
    );

    expect(screen.getByText("Run the installer, then restart.")).toBeTruthy();
    expect(screen.queryByText("Reinstall the previous tarball.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Rollback guidance/ }));
    expect(screen.getByText("Reinstall the previous tarball.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Instructions/ }));
    expect(screen.queryByText("Run the installer, then restart.")).toBeNull();
  });

  it("offers no disclosure for guidance the release did not declare", () => {
    render(
      <AssistedUpdateGate
        tag="v1.1.0"
        required
        metadata={{
          mode: "required",
          title: "Service manager rewrite",
          summary: "The launchd plist changes shape.",
          requiredChecks: [],
        }}
      />
    );

    expect(screen.queryByRole("button", { name: /Instructions/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Rollback guidance/ })
    ).toBeNull();
    expect(screen.queryByText("Required checks")).toBeNull();
  });
});
