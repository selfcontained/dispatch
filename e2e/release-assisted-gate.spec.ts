import { test, expect } from "@playwright/test";
import { loadApp } from "./helpers";

const requiredInfoFixture = {
  currentTag: "v0.18.1",
  channel: "stable" as const,
  isAdmin: true,
  latestTag: "v0.19.0",
  updateAvailable: true,
  latestRelease: {
    tag: "v0.19.0",
    publishedAt: "2026-04-25T12:00:00Z",
    url: "https://github.com/selfcontained/dispatch/releases/tag/v0.19.0",
  },
  unreleasedCount: 0,
  commits: [],
  refMissing: false,
  assisted: {
    mode: "required",
    title: "Bun runtime migration",
    summary:
      "This release switches the runtime from Node to Bun and changes the systemd unit shape.",
    instructions:
      "1. Confirm the service stopped cleanly.\n2. Replace the runtime symlink.\n3. Restart and watch /api/v1/health.",
    requiredChecks: [
      "expected_runtime_artifact",
      "service_entrypoint",
      "service_restarted",
      "health_endpoint",
      "version_converged",
    ],
    rollbackGuidance:
      "If health does not return within 60s, restore the previous symlink and `launchctl kickstart -k`.",
    appliesFrom: "v0.18.0",
  },
  assistedRequired: true,
};

const recommendedInfoFixture = {
  ...requiredInfoFixture,
  assisted: {
    ...requiredInfoFixture.assisted,
    mode: "recommended",
    title: "Recommended assisted update",
  },
  assistedRequired: false,
};

test.describe("Release assisted-update gate", () => {
  test("renders the required-mode gate and hides the one-click button", async ({
    page,
  }) => {
    await page.route("**/api/v1/release/info", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(requiredInfoFixture),
      })
    );

    await loadApp(page);
    await page.getByTestId("settings-button").click();
    await page
      .locator("button", { hasText: /^Updates$/ })
      .first()
      .click();
    await page.getByText("Check for updates").click();

    // The required-mode gate must be visible…
    await expect(
      page.getByText("Assisted update required", { exact: true })
    ).toBeVisible();
    await expect(page.getByText("Bun runtime migration")).toBeVisible();
    await expect(
      page.getByText(/switches the runtime from Node to Bun/)
    ).toBeVisible();
    // …and the standard one-click "Update to vX.Y.Z" button must NOT be.
    await expect(
      page.getByRole("button", { name: /^Update to v0\.19\.0$/ })
    ).toHaveCount(0);
    // Required-checks list shows up.
    for (const check of [
      "expected_runtime_artifact",
      "service_entrypoint",
      "service_restarted",
      "health_endpoint",
      "version_converged",
    ]) {
      await expect(page.getByText(check)).toBeVisible();
    }

    const startButton = page.getByRole("button", {
      name: /Start assisted update to v0\.19\.0/,
    });
    await expect(startButton).toBeEnabled();
  });

  test("renders the recommended gate alongside the recommended copy", async ({
    page,
  }) => {
    await page.route("**/api/v1/release/info", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(recommendedInfoFixture),
      })
    );

    await loadApp(page);
    await page.getByTestId("settings-button").click();
    await page
      .locator("button", { hasText: /^Updates$/ })
      .first()
      .click();
    await page.getByText("Check for updates").click();

    await expect(
      page.getByText("Assisted update recommended", { exact: true })
    ).toBeVisible();
    // For recommended mode the gate is informational; it still hides the
    // standard one-click button by design (any release that publishes
    // metadata is opting into the assisted flow).
    await expect(
      page.getByRole("button", { name: /^Update to v0\.19\.0$/ })
    ).toHaveCount(0);
  });

  test("gate fits a 375px viewport without horizontal overflow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.route("**/api/v1/release/info", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(requiredInfoFixture),
      })
    );

    // Visit the updates pane directly — the mobile layout collapses the
    // sidebar nav, so navigating via the settings button isn't a clean
    // path for a layout regression test.
    await page.goto("/settings/updates");
    await expect(page.getByText("Current version")).toBeVisible();
    await page.getByText("Check for updates").click();
    await expect(page.getByText("Bun runtime migration")).toBeVisible();

    // No element should poke past the viewport — guards against the long
    // check names and rollback guidance section pushing the page wide.
    const overflows = await page.evaluate(() => {
      const docWidth = document.documentElement.clientWidth;
      return Array.from(document.querySelectorAll("*"))
        .filter(
          (el) =>
            (el as HTMLElement).getBoundingClientRect().right > docWidth + 1
        )
        .map(
          (el) => (el as HTMLElement).tagName + "#" + (el as HTMLElement).id
        );
    });
    expect(overflows).toEqual([]);
  });
});

test.describe("Release assisted-update progress takeover", () => {
  test("renders structured phases, notes and check results from SSE", async ({
    page,
  }) => {
    // Install a controllable EventSource stub before any page script
    // runs so `useReleaseStream`'s connect picks up our fake instead of
    // hitting the real /api/v1/release/stream.
    await page.addInitScript(() => {
      class FakeES {
        readyState = 1;
        url = "";
        withCredentials = false;
        CONNECTING = 0 as const;
        OPEN = 1 as const;
        CLOSED = 2 as const;
        onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
        onmessage:
          | ((this: EventSource, ev: MessageEvent<string>) => unknown)
          | null = null;
        onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
        addEventListener() {}
        removeEventListener() {}
        dispatchEvent() {
          return true;
        }
        constructor(url: string) {
          this.url = url;
          (window as unknown as { __pwES?: FakeES }).__pwES = this;
        }
        close() {
          this.readyState = 2;
        }
      }
      // @ts-expect-error swap the global for the test
      window.EventSource = FakeES;
    });

    await loadApp(page);
    await page.getByTestId("settings-button").click();
    await page
      .locator("button", { hasText: /^Updates$/ })
      .first()
      .click();

    // Wait for the hook's connectStream() useEffect to run, which sets
    // onmessage on our FakeES.
    await page.waitForFunction(() => {
      const w = window as unknown as {
        __pwES?: { onmessage: unknown };
      };
      return Boolean(w.__pwES && typeof w.__pwES.onmessage === "function");
    });

    const job = {
      jobType: "update-assisted",
      versionType: null,
      phase: "validate",
      startedAt: "2026-04-26T05:00:00.000Z",
      log: [
        "==> assisted update launched for v0.19.0",
        "==> phase prepare: snapshotted current install",
        "==> phase apply: swapped symlink",
        "==> phase validate: service restarted",
      ],
      runUrl: null,
      tag: "v0.19.0",
      error: null,
      assisted: {
        tag: "v0.19.0",
        fromTag: "v0.18.1",
        metadata: {
          mode: "required",
          title: "Bun runtime migration",
          summary: "Demo run.",
          requiredChecks: ["service_entrypoint", "version_converged"],
        },
        requiredChecks: ["service_entrypoint", "version_converged"],
        phase: "validate",
        agentId: "agt_demo000000",
        startedAt: "2026-04-26T05:00:00.000Z",
        updatedAt: "2026-04-26T05:00:01.000Z",
        completedAt: null,
        error: null,
        checks: [
          {
            name: "service_entrypoint",
            ok: true,
            message: "start script: node dist/main.js",
          },
          {
            name: "version_converged",
            ok: true,
            message: "installed version converged to v0.19.0",
          },
        ],
        notes: {
          prepare: "snapshotted current install",
          apply: "swapped symlink",
        },
      },
    };

    await page.evaluate((payload) => {
      const w = window as unknown as { __pwES?: EventSource };
      const es = w.__pwES;
      if (!es?.onmessage) throw new Error("EventSource onmessage not bound");
      es.onmessage.call(
        es as EventSource,
        {
          data: JSON.stringify({ type: "snapshot", job: payload }),
        } as unknown as MessageEvent<string>
      );
    }, job);

    // Takeover replaces the settings pane. Use toBeAttached for the
    // long-form content since the takeover lives inside a scrollable
    // container and not everything is in the initial viewport.
    await expect(page.getByText("Bun runtime migration")).toBeVisible();
    await expect(
      page.getByText("Validate checks", { exact: true })
    ).toBeAttached();

    // Per-phase notes show up. The same text also appears in the log
    // panel, so use exact-match against the structured note rendering.
    await expect(
      page.getByText("snapshotted current install", { exact: true })
    ).toBeAttached();
    await expect(
      page.getByText("swapped symlink", { exact: true })
    ).toBeAttached();

    // Check results render with their messages.
    await expect(
      page.getByText("start script: node dist/main.js")
    ).toBeAttached();
    await expect(
      page.getByText("installed version converged to v0.19.0")
    ).toBeAttached();

    // The agent's id is surfaced as a link target back to the agent page.
    await expect(page.getByText(/View update agent/)).toBeAttached();
  });
});
