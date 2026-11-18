import { expect, test, type Page } from "@playwright/test";
import { authHeaders, cleanupE2EAgents } from "../helpers";
import {
  agentInfo,
  chat,
  createPairing,
  enrollViaUi,
  revokeViaUi,
  guestOk,
  invocations,
  lane,
  launchViaApi,
  launchViaUi,
  marker,
  newSettledTurn,
  runnerOptionEnabled,
  pairInContainer,
  runnerRow,
  runnerRows,
  state,
  type RunnerName,
} from "./harness";

// One serial fleet: a local agent plus two Docker runners that both expose a
// workspace named "proof". Marker files differ per runner, so any output or
// file landing on the wrong side is visible.
test.describe.configure({ mode: "serial" });
const WS = state.workspace;
const runnerIds: Partial<Record<RunnerName, string>> = {};
// Placement is keyed by the opaque registration id, never the display name.
const loc = (r: RunnerName) => `runner://${runnerIds[r]}/${WS}`;
const agents: Record<"local" | RunnerName, string> = {
  local: "",
  alpha: "",
  beta: "",
};
const pages: Partial<Record<keyof typeof agents, Page>> = {};

test.beforeAll(() => {
  expect(process.env.DISPATCH_AGENT_RUNTIME).toBe("acp");
});
test.afterAll(async ({ request }) => {
  await cleanupE2EAgents(request);
});

const text = (p: Page) => p.locator("body");
const answers = (p: Page, s: string) => p.getByText(s, { exact: false });

test("enroll two runners with identical workspace names", async ({
  page,
  request,
}) => {
  runnerIds.alpha = await enrollViaUi(page, request, "alpha");
  runnerIds.beta = await enrollViaUi(page, request, "beta");
  const rows = await runnerRows(request);
  for (const n of ["alpha", "beta"]) {
    const row = rows.find((r) => r.name === n)!;
    expect(row.status).toBe("online");
    expect(row.workspaces).toContain(WS);
  }
  expect(marker("alpha")).not.toBe(marker("beta"));
});

test("UI launches local, alpha and beta; each answer comes from its own side", async ({
  browser,
}, testInfo) => {
  for (const [key, prompt] of [
    ["local", "local-start"],
    ["alpha", "prove-marker proof-count"],
    ["beta", "prove-marker proof-count"],
  ] as const) {
    const page = await (await browser.newContext()).newPage();
    pages[key] = page;
    const { status, id } = await launchViaUi(
      page,
      key === "local"
        ? { name: `e2e-rr-${key}`, cwd: "/tmp", prompt }
        : {
            name: `e2e-rr-${key}`,
            runnerId: runnerIds[key],
            prompt,
            restricted: true,
          }
    );
    expect(status).toBe(201);
    agents[key] = id!;
    if (key !== "local")
      expect((await agentInfo(page.request, id!)).cwd).toBe(loc(key));
    await expect(page).toHaveURL((u) => u.pathname === `/agents/${id}`, {
      timeout: 15_000,
    });
  }
  await expect(answers(pages.local!, "You said:")).toBeVisible({
    timeout: 45_000,
  });
  for (const r of ["alpha", "beta"] as const) {
    const other: RunnerName = r === "alpha" ? "beta" : "alpha";
    await expect(answers(pages[r]!, `Guest marker ${marker(r)}`)).toBeVisible({
      timeout: 45_000,
    });
    await expect(text(pages[r]!)).not.toContainText(marker(other));
    expect(invocations(r)).toBe(1);
    // The approved repo operation ran in this runner's workspace only.
    expect(guestOk(r, `test -f ${state.runners[r].workspaceDir}/repo-op`)).toBe(
      true
    );
    expect(
      guestOk(
        other,
        `test -f ${state.runners[other].workspaceDir}/provider-invocations && test "$(wc -l < ${state.runners[other].workspaceDir}/provider-invocations)" -gt 1`
      )
    ).toBe(false);
  }
  await testInfo.attach("three agents", {
    body: await pages.alpha!.screenshot(),
    contentType: "image/png",
  });
});

test("permissions are answered per runner and never cross", async () => {
  for (const r of ["alpha", "beta"] as const)
    await chat(pages[r]!, "prove-permission");
  const ask = (r: RunnerName) => pages[r]!.getByTestId("permission-requests");
  await expect(ask("alpha")).toBeVisible({ timeout: 30_000 });
  await expect(ask("beta")).toBeVisible({ timeout: 30_000 });
  await ask("alpha")
    .getByRole("button", { name: "Allow once", exact: true })
    .click();
  await expect(ask("alpha")).toHaveCount(0);
  // Alpha's approval wrote only alpha's file; beta is still waiting.
  await expect
    .poll(() =>
      guestOk(
        "alpha",
        `test -f ${state.runners.alpha.workspaceDir}/protected-action`
      )
    )
    .toBe(true);
  expect(
    guestOk(
      "beta",
      `test -f ${state.runners.beta.workspaceDir}/protected-action`
    )
  ).toBe(false);
  await expect(ask("beta")).toBeVisible();
  await ask("beta").getByRole("button", { name: "Deny", exact: true }).click();
  await expect(
    answers(pages.beta!, "Guest permission answered.").last()
  ).toBeVisible({ timeout: 30_000 });
  expect(
    guestOk(
      "beta",
      `test -f ${state.runners.beta.workspaceDir}/protected-action`
    )
  ).toBe(false);
});

test("disconnect alpha mid-turn: others continue; reconnect gives one invocation and one completion", async ({
  request,
}, testInfo) => {
  const before = invocations("alpha");
  await chat(pages.alpha!, "proof-delay:25000 proof-count");
  await expect(
    answers(pages.alpha!, "Guest turn waiting for reconnect.")
  ).toBeVisible({ timeout: 30_000 });
  await lane("alpha", "block"); // sever now, refuse reconnects
  await expect
    .poll(async () => (await runnerRow(request, "alpha"))?.status, {
      timeout: 30_000,
    })
    .toBe("offline");
  await testInfo.attach("alpha disconnected", {
    body: await pages.alpha!.screenshot(),
    contentType: "image/png",
  });

  // Beta and local keep working while alpha is away.
  const betaBefore = invocations("beta");
  await newSettledTurn(
    pages.beta!,
    "proof-count after-alpha-lost",
    "Local or guest fixture turn completed."
  );
  expect(invocations("beta")).toBe(betaBefore + 1);
  await newSettledTurn(
    pages.local!,
    "sleep:500 still-local",
    "You said: sleep:500 still-local"
  );
  expect((await runnerRow(request, "beta"))?.status).toBe("online");

  await lane("alpha", "allow");
  await expect
    .poll(async () => (await runnerRow(request, "alpha"))?.status, {
      timeout: 60_000,
    })
    .toBe("online");
  await expect(
    answers(pages.alpha!, "Guest turn completed after reconnect.")
  ).toHaveCount(1, { timeout: 60_000 });
  expect(invocations("alpha")).toBe(before + 1);
  await expect(
    answers(pages.alpha!, "Guest turn completed after reconnect.")
  ).toHaveCount(1);
  await testInfo.attach("alpha recovered", {
    body: await pages.alpha!.screenshot(),
    contentType: "image/png",
  });
});

test("revoke alpha: it cannot return, beta and local are unaffected", async ({
  page,
  request,
}, testInfo) => {
  await revokeViaUi(page, runnerIds.alpha!);
  await expect
    .poll(async () => (await runnerRow(request, "alpha"))?.status)
    .toBe("revoked");
  // The runner process keeps retrying; it must stay out.
  await new Promise((r) => setTimeout(r, 4000));
  expect((await runnerRow(request, "alpha"))?.status).toBe("revoked");
  const alphaInvocations = invocations("alpha");
  await chat(pages.alpha!, "proof-count after-revoke").catch(() => undefined);
  await new Promise((r) => setTimeout(r, 3000));
  expect(invocations("alpha")).toBe(alphaInvocations);
  await testInfo.attach("alpha revoked", {
    body: await pages.alpha!.screenshot(),
    contentType: "image/png",
  });

  const betaBefore = invocations("beta");
  await newSettledTurn(
    pages.beta!,
    "proof-count after-revoke",
    "Local or guest fixture turn completed."
  );
  expect(invocations("beta")).toBe(betaBefore + 1);
  await newSettledTurn(
    pages.local!,
    "after-revoke-local",
    "You said: after-revoke-local"
  );
  expect((await runnerRow(request, "beta"))?.status).toBe("online");
  expect((await agentInfo(request, agents.beta)).cwd).toBe(loc("beta"));
});

// ---------------------------------------------------------------- failures
test.describe("failure suite", () => {
  test("pairing codes are single-use and wrong codes are refused", async ({
    request,
  }) => {
    const { body } = await createPairing(request, "gamma");
    expect(body).not.toBeNull();
    const bad = body!.command.replace(/--code\s+\S+/, "--code WRONGCODE");
    expect(() => pairInContainer("beta", bad)).toThrow();
    // Pair the unused code into a throwaway dir so beta's live credentials stay intact.
    pairInContainer("beta", body!.command, "/tmp/gamma-creds");
    expect(() =>
      pairInContainer("beta", body!.command, "/tmp/gamma-creds-2")
    ).toThrow(); // replay
    const row = await runnerRow(request, "gamma");
    expect(["pending", "online", "offline"]).toContain(row?.status);
  });

  test("unknown runner and workspace are refused; revoked runner is not selectable", async ({
    page,
    request,
  }) => {
    for (const cwd of [
      "runner://nobody/proof",
      `runner://${runnerIds.beta}/not-a-workspace`,
      loc("alpha"),
    ])
      expect(await launchViaApi(request, cwd), cwd).toBeGreaterThanOrEqual(400);
    expect(await runnerOptionEnabled(page, runnerIds.alpha!)).toBe(false);
    expect(await runnerOptionEnabled(page, runnerIds.beta!)).toBe(true);
  });

  test("flapping transport does not duplicate prompts or completions", async ({
    request,
  }) => {
    const before = invocations("beta");
    await chat(pages.beta!, "proof-delay:12000 proof-count flap");
    await expect(
      answers(pages.beta!, "Guest turn waiting for reconnect.").last()
    ).toBeVisible({ timeout: 30_000 });
    for (let i = 0; i < 3; i++) {
      await lane("beta", "sever");
      await new Promise((r) => setTimeout(r, 1500));
    }
    await expect
      .poll(async () => (await runnerRow(request, "beta"))?.status, {
        timeout: 60_000,
      })
      .toBe("online");
    await expect(
      answers(pages.beta!, "Guest turn completed after reconnect.").last()
    ).toBeVisible({ timeout: 60_000 });
    expect(invocations("beta")).toBe(before + 1);
  });

  test("launch while a runner is unreachable fails cleanly and leaves others alone", async ({
    page,
    request,
  }) => {
    await lane("beta", "block");
    await expect
      .poll(async () => (await runnerRow(request, "beta"))?.status, {
        timeout: 30_000,
      })
      .toBe("offline");
    expect(await launchViaApi(request, loc("beta"))).toBeGreaterThanOrEqual(
      400
    );
    expect(await runnerOptionEnabled(page, runnerIds.beta!)).toBe(false);
    await newSettledTurn(
      pages.local!,
      "local-while-beta-down",
      "You said: local-while-beta-down"
    );
    await lane("beta", "allow");
    await expect
      .poll(async () => (await runnerRow(request, "beta"))?.status, {
        timeout: 60_000,
      })
      .toBe("online");
  });
});
