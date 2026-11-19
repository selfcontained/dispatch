import { expect, test, type Page } from "@playwright/test";
import type { AgentPermissionsResponse } from "@dispatch/shared";
import { authHeaders, cleanupE2EAgents } from "../helpers";
import {
  agentInfo,
  chat,
  crashRunner,
  startRunner,
  enrollViaUi,
  revokeViaUi,
  guest,
  guestDiagnostics,
  guestOk,
  invocations,
  lane,
  launchViaApi,
  launchViaUi,
  marker,
  newSettledTurn,
  runnerOptionEnabled,
  requestConnection,
  runnerRow,
  runnerRows,
  state,
  settledTurns,
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
  await Promise.all(
    Object.values(pages).map((page) => page?.context().close())
  );
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  for (const name of ["alpha", "beta", "scratch"] as const) {
    await testInfo.attach(`${name} runner diagnostics`, {
      body: guestDiagnostics(name),
      contentType: "text/plain",
    });
  }
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
  baseURL,
  browser,
}, testInfo) => {
  for (const [key, prompt] of [
    ["local", "local-start"],
    ["alpha", "prove-marker proof-count"],
    ["beta", "prove-marker proof-count"],
  ] as const) {
    const page = await (await browser.newContext({ baseURL })).newPage();
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

test("permission decisions stay on their runner across a disconnect", async ({
  request,
}, testInfo) => {
  const betaBefore = invocations("beta");
  const url = `/api/v1/agents/${agents.beta}/permissions`;
  const betaPermissions = async (): Promise<AgentPermissionsResponse> => {
    const response = await request.get(url, { headers: authHeaders() });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  for (const r of ["alpha", "beta"] as const)
    await chat(pages[r]!, "prove-permission");
  const ask = (r: RunnerName) => pages[r]!.getByTestId("permission-requests");
  await expect(ask("alpha")).toBeVisible({ timeout: 30_000 });
  await expect(ask("beta")).toBeVisible({ timeout: 30_000 });
  const pending = (await betaPermissions()).requests;
  expect(pending).toHaveLength(1);
  const permissionId = pending[0]!.id;
  await lane("beta", "block");
  await expect
    .poll(async () => (await betaPermissions()).connected)
    .toBe(false);
  const offlineAnswer = await request.post(
    `${url}/${encodeURIComponent(permissionId)}`,
    {
      headers: authHeaders(),
      data: { optionId: "allow" },
    }
  );
  expect(offlineAnswer.status()).toBe(409);
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
  await lane("beta", "allow");
  await expect.poll(betaPermissions, { timeout: 60_000 }).toMatchObject({
    connected: true,
    requests: [{ id: permissionId }],
  });
  await expect(ask("beta")).toBeVisible();
  await testInfo.attach("beta waiting after alpha approval", {
    body: await pages.beta!.screenshot(),
    contentType: "image/png",
  });
  await ask("beta").getByRole("button", { name: "Deny", exact: true }).click();
  await expect(
    answers(pages.beta!, "Guest permission answered.").last()
  ).toBeVisible({ timeout: 30_000 });
  expect(invocations("beta")).toBe(betaBefore + 1);
  expect(
    guestOk(
      "beta",
      `test -f ${state.runners.beta.workspaceDir}/protected-action`
    )
  ).toBe(false);
});

test("runner supervisor restarts mid-turn and reattaches to the original host", async ({
  request,
}, testInfo) => {
  const page = pages.beta!;
  const pidFile = `/var/lib/runner/hosts/${agents.beta}/host.pid`;
  const pid = guest("beta", `cat ${pidFile}`).trim();
  expect(pid).toMatch(/^[1-9][0-9]*$/);
  const before = invocations("beta");
  const turns = await settledTurns(page).count();
  await chat(page, "proof-delay:12000 proof-count supervisor-restart");
  await expect(answers(page, "Guest turn waiting for reconnect.")).toBeVisible({
    timeout: 30_000,
  });
  crashRunner("beta");
  await expect
    .poll(async () => (await runnerRow(request, "beta"))?.status)
    .toBe("offline");
  expect(guestOk("beta", `kill -0 ${pid}`)).toBe(true);
  startRunner("beta");
  await expect
    .poll(async () => (await runnerRow(request, "beta"))?.status, {
      timeout: 30_000,
    })
    .toBe("online");
  await expect(settledTurns(page)).toHaveCount(turns + 1, { timeout: 60_000 });
  await expect(
    answers(page, "Guest turn completed after reconnect.")
  ).toHaveCount(1);
  expect(invocations("beta")).toBe(before + 1);
  expect(guest("beta", `cat ${pidFile}`).trim()).toBe(pid);
  await newSettledTurn(
    page,
    "proof-count after-supervisor-restart",
    "Local or guest fixture turn completed."
  );
  expect(invocations("beta")).toBe(before + 2);
  await testInfo.attach("runner supervisor recovered", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
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
  await newSettledTurn(pages.local!, "sleep:500 still-local", [
    "Waiting for the requested delay.",
    "You said:",
    "still-local",
  ]);
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
  const alphaInvocations = invocations("alpha");
  await revokeViaUi(page, runnerIds.alpha!);
  await expect
    .poll(async () => (await runnerRow(request, "alpha"))?.status)
    .toBe("revoked");
  // The runner process keeps retrying; it must stay out.
  await new Promise((r) => setTimeout(r, 4000));
  expect((await runnerRow(request, "alpha"))?.status).toBe("revoked");
  await expect
    .poll(async () => (await agentInfo(request, agents.alpha)).status)
    .toBe("error");
  expect(await launchViaApi(request, loc("alpha"))).toBe(409);
  expect(invocations("alpha")).toBe(alphaInvocations);
  await testInfo.attach("alpha revoked", {
    body: await page.getByTestId("runner-settings").screenshot(),
    contentType: "image/png",
  });

  const betaBefore = invocations("beta");
  await newSettledTurn(
    pages.beta!,
    "proof-count after-revoke",
    "Local or guest fixture turn completed."
  );
  expect(invocations("beta")).toBe(betaBefore + 1);
  await newSettledTurn(pages.local!, "after-revoke-local", [
    "You said:",
    "after-revoke-local",
  ]);
  expect((await runnerRow(request, "beta"))?.status).toBe("online");
  expect((await agentInfo(request, agents.beta)).cwd).toBe(loc("beta"));
});

// ---------------------------------------------------------------- failures
test.describe("failure suite", () => {
  test("approval codes are single-use and wrong codes are refused", async ({
    page,
    request,
  }) => {
    const { form, code, finished } = await requestConnection(
      page,
      "beta",
      "/tmp/gamma-creds"
    );
    await form.getByLabel("Runner name").fill("gamma");
    const approve = async (value: string) => {
      await form.getByLabel("Pairing code").fill(value);
      const response = page.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          new URL(r.url()).pathname.endsWith("/approve")
      );
      await form.getByRole("button", { name: "Approve runner" }).click();
      return response;
    };
    expect((await approve("WRONGCODE")).status()).toBeGreaterThanOrEqual(400);
    await expect(form.getByRole("alert")).toBeVisible();
    const approved = await approve(code);
    expect(approved.ok(), await approved.text()).toBe(true);
    expect(await finished).toBe(true);
    await expect(form).toHaveCount(0);
    const replay = await request.post(approved.url(), {
      headers: authHeaders(),
      data: { name: "gamma", code },
    });
    expect(replay.status()).toBeGreaterThanOrEqual(400);
    expect(
      (await runnerRows(request)).filter((row) => row.name === "gamma")
    ).toHaveLength(1);
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
    const previous = await settledTurns(pages.beta!).count();
    await chat(pages.beta!, "proof-delay:12000 proof-count flap");
    await expect(
      answers(pages.beta!, "Guest turn waiting for reconnect.").last()
    ).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => invocations("beta")).toBe(before + 1);
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
    await expect(settledTurns(pages.beta!)).toHaveCount(previous + 1, {
      timeout: 60_000,
    });
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
    await newSettledTurn(pages.local!, "local-while-beta-down", [
      "You said:",
      "local-while-beta-down",
    ]);
    await lane("beta", "allow");
    await expect
      .poll(async () => (await runnerRow(request, "beta"))?.status, {
        timeout: 60_000,
      })
      .toBe("online");
  });
});

test("managed scratch launch reports health and archive removes the guest session folder", async ({
  page,
  request,
}, testInfo) => {
  const runnerId = await enrollViaUi(page, request, "scratch");
  expect((await runnerRow(request, "scratch"))?.workspaces).toEqual([
    "@session",
  ]);
  const { status, id } = await launchViaUi(page, {
    name: "e2e-rr-managed-scratch",
    runnerId,
    managedScratch: true,
    prompt: "proof-count scratch-start",
  });
  expect(status).toBe(201);
  expect(id).toMatch(/^agt_[a-z0-9]+$/);
  expect((await agentInfo(request, id!)).cwd).toBe(
    `runner://${runnerId}/@session`
  );
  await expect(page).toHaveURL((url) => url.pathname === `/agents/${id}`);
  await expect(settledTurns(page)).toHaveCount(1, { timeout: 45_000 });
  await expect(
    settledTurns(page).last().getByTestId("harness-result")
  ).toContainText("Local or guest fixture turn completed.");
  const directory = `/var/lib/runner/sessions/${id}`;
  expect(guest("scratch", `stat -c '%u:%g %a' ${directory}`).trim()).toBe(
    "1500:1500 700"
  );
  expect(guest("scratch", `cat ${directory}/provider-invocations`).trim()).toBe(
    "called"
  );

  const scratchPid = guest(
    "scratch",
    `cat /var/lib/runner/hosts/${id}/host.pid`
  ).trim();
  expect(scratchPid).toMatch(/^[1-9][0-9]*$/);
  crashRunner("scratch");
  await expect
    .poll(async () => (await runnerRow(request, "scratch"))?.status)
    .toBe("offline");
  startRunner("scratch");
  await expect
    .poll(async () => (await runnerRow(request, "scratch"))?.status, {
      timeout: 30_000,
    })
    .toBe("online");
  await newSettledTurn(
    page,
    "proof-count after-scratch-recovery",
    "Local or guest fixture turn completed."
  );
  expect(
    guest("scratch", `cat /var/lib/runner/hosts/${id}/host.pid`).trim()
  ).toBe(scratchPid);

  await page.goto("/settings/connections", { waitUntil: "domcontentloaded" });
  await page.getByTestId(`runner-select-${runnerId}`).click();
  const health = page.getByTestId("runner-detail").getByTestId("runner-health");
  const summary = health.locator("summary");
  await expect(summary).toContainText("1 session", { timeout: 45_000 });
  await summary.click();
  await expect(health.getByText("Memory", { exact: true })).toBeVisible();
  await expect(
    health.getByText("Runner version", { exact: true })
  ).toBeVisible();
  await testInfo.attach("managed scratch health", {
    body: await page.getByTestId("runner-detail").screenshot(),
    contentType: "image/png",
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  const archive = page.getByTestId(`agent-archive-${id}`);
  if (!(await archive.isVisible()))
    await page.getByTestId(`agent-expand-toggle-${id}`).click();
  await archive.click();
  await expect(
    page.getByRole("dialog", { name: "Archive Agent" })
  ).toContainText("The runner will delete its session folder");
  await page.getByTestId("delete-agent-confirm").click();
  await expect(page.getByTestId(`agent-card-${id}`)).toHaveCount(0);
  await expect
    .poll(() => guestOk("scratch", `test ! -e ${directory}`), {
      timeout: 30_000,
    })
    .toBe(true);
});
