import { expect, test, type Page } from "@playwright/test";
import type { AgentPermissionsResponse } from "@dispatch/shared";
import { authHeaders, cleanupE2EAgents, trackAgent } from "../helpers";
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
  invocations as countInvocations,
  lane,
  launchViaApi,
  launchViaUi,
  marker,
  newSettledTurn,
  runnerOptionEnabled,
  requestConnection,
  runnerRow,
  runnerRows,
  repositoryProject,
  state,
  settledTurns,
  type RunnerName,
} from "./harness";

// Each runner clones its own marked repository. A file or answer from the wrong machine is visible.
test.describe.configure({ mode: "serial" });
const runnerIds: Partial<Record<RunnerName, string>> = {};
const projectIds: Partial<Record<RunnerName, string>> = {};
const directories: Partial<Record<RunnerName, string>> = {};
const target = (name: RunnerName) => ({
  runner: runnerIds[name]!,
  projectId: projectIds[name]!,
});
const invocations = (name: RunnerName) =>
  countInvocations(name, directories[name]!);
const agents: Record<"local" | RunnerName, string> = {
  local: "",
  alpha: "",
  beta: "",
};
const projects: string[] = [];
const pages: Partial<Record<keyof typeof agents, Page>> = {};

test.beforeAll(() => {
  expect(process.env.DISPATCH_AGENT_RUNTIME).toBe("acp");
});
test.afterAll(async ({ request }) => {
  await cleanupE2EAgents(request);
  for (const id of projects)
    await request.delete(`/api/v1/projects/${id}`, { headers: authHeaders() });
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

test("enroll two runners with distinct registrations", async ({
  page,
  request,
}) => {
  runnerIds.alpha = await enrollViaUi(page, request, "alpha");
  runnerIds.beta = await enrollViaUi(page, request, "beta");
  const rows = await runnerRows(request);
  for (const n of ["alpha", "beta"]) {
    const row = rows.find((r) => r.name === n)!;
    expect(row.status).toBe("online");
  }
  expect(state.runners.alpha.workspaceDir).toBe(
    state.runners.beta.workspaceDir
  );
  expect(marker("alpha")).not.toBe(marker("beta"));
});

async function launchProjectFixture(
  page: Page,
  opts: {
    name: string;
    runner: string;
    prompt: string;
    restricted?: boolean;
    projectId?: string;
  }
) {
  const { name, runner, prompt, restricted } = opts;
  const response = await page.request.post("/api/v1/agents", {
    headers: authHeaders(),
    data: {
      name,
      projectId: opts.projectId,
      runner,
      cwd: "",
      type: "claude",
      fullAccess: !restricted,
      useWorktree: false,
      initialPrompt: prompt,
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const { agent } = (await response.json()) as { agent: { id: string } };
  trackAgent(agent.id);
  await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
  return { status: response.status(), id: agent.id };
}

test("local and runner fixture launches answer from their own side", async ({
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
    if (key !== "local") {
      projectIds[key] = await repositoryProject(
        page.request,
        key,
        undefined,
        "main",
        true
      );
      projects.push(projectIds[key]!);
    }
    const { status, id } =
      key === "local"
        ? await launchViaUi(page, {
            name: `e2e-rr-${key}`,
            cwd: "/tmp",
            prompt,
          })
        : await launchProjectFixture(page, {
            name: `e2e-rr-${key}`,
            ...target(key),
            prompt,
            restricted: true,
          });
    expect(status).toBe(201);
    agents[key] = id!;
    if (key !== "local") {
      const expected = `/var/lib/runner/sessions/${id}/checkout`;
      await expect
        .poll(async () => (await agentInfo(page.request, id!)).cwd, {
          timeout: 45000,
        })
        .toBe(expected);
      directories[key] = expected;
    }
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
    await expect(answers(pages[r]!, "Approved repo operation:")).toBeVisible({
      timeout: 15_000,
    });
    expect(guestOk(r, `test -f ${directories[r]}/repo-op`)).toBe(true);
    expect(
      guestOk(
        other,
        `test -f ${directories[other]}/provider-invocations && test "$(wc -l < ${directories[other]}/provider-invocations)" -gt 1`
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
    await chat(pages[r]!, "proof-count prove-permission");
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
      guestOk("alpha", `test -f ${directories.alpha}/protected-action`)
    )
    .toBe(true);
  expect(guestOk("beta", `test -f ${directories.beta}/protected-action`)).toBe(
    false
  );
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
  expect(guestOk("beta", `test -f ${directories.beta}/protected-action`)).toBe(
    false
  );
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
  expect(await launchViaApi(request, target("alpha"))).toBe(409);
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
  expect((await agentInfo(request, agents.beta)).cwd).toBe(directories.beta);
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

  test("unknown and revoked runners are refused at launch", async ({
    page,
    request,
  }) => {
    for (const runner of ["nobody", runnerIds.alpha!])
      expect(
        await launchViaApi(request, { runner, projectId: projectIds.beta! })
      ).toBeGreaterThanOrEqual(400);
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
    expect(await launchViaApi(request, target("beta"))).toBeGreaterThanOrEqual(
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

test("managed scratch checkout selection persists across host start and preserves archive ownership", async ({
  page,
  request,
}, testInfo) => {
  const runnerId = await enrollViaUi(page, request, "scratch");
  const projectId = await repositoryProject(request, "scratch");
  projects.push(projectId);
  const { status, id } = await launchProjectFixture(page, {
    projectId,
    name: "e2e-rr-managed-scratch",
    runner: runnerId,
    prompt: "proof-count scratch-start",
  });
  expect(status).toBe(201);
  expect(id).toMatch(/^agt_[a-z0-9]+$/);
  await expect
    .poll(async () => (await agentInfo(request, id!)).cwd, { timeout: 45000 })
    .toBe(`/var/lib/runner/sessions/${id}/checkout`);
  await expect(page).toHaveURL((url) => url.pathname === `/agents/${id}`);
  await expect(settledTurns(page)).toHaveCount(1, { timeout: 45_000 });
  await expect(
    settledTurns(page).last().getByTestId("harness-result")
  ).toContainText("Local or guest fixture turn completed.");
  // The runner records workspace preparation on the launch request before
  // the fixture engine can return its first turn.
  const stream = await request.get(`/api/v1/streams/${id}/blocks`, {
    headers: authHeaders(),
  });
  expect(stream.ok(), await stream.text()).toBe(true);
  expect(await stream.text()).toContain("Starting Claude");
  const directory = `/var/lib/runner/sessions/${id}/checkout`;
  expect(guest("scratch", `stat -c '%u:%g %a' ${directory}`).trim()).toBe(
    "1500:1500 755"
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

  const selected = "/tmp/dispatch-selected-checkout";
  guest(
    "scratch",
    [
      `mkdir -p ${selected}/src`,
      `git init -q ${selected}`,
      `echo "Selected on the enrolled runner" > ${selected}/selected-checkout.txt`,
      `chown -R 1500:1500 ${selected}`,
    ].join(" && ")
  );
  const workspaceRoute = `/api/v1/agents/${id}/workspace`;
  const updateWorkspace = (path: string | null) =>
    request.patch(workspaceRoute, {
      headers: authHeaders(),
      data: { path },
    });
  const changed = await updateWorkspace(`${selected}/src`);
  expect(changed.ok(), await changed.text()).toBe(true);
  expect((await changed.json()).agent).toMatchObject({
    cwd: `/var/lib/runner/sessions/${id}/checkout`,
    workspacePath: selected,
  });
  {
    const workspace = selected;
    const files = await request.get(workspaceRoute, {
      headers: authHeaders(),
      params: { workspace, path: "" },
    });
    expect(files.ok(), await files.text()).toBe(true);
    expect(await files.text()).toContain("selected-checkout.txt");
  }
  const stop = await request.post(`/api/v1/agents/${id}/stop`, {
    headers: authHeaders(),
  });
  expect(stop.ok(), await stop.text()).toBe(true);
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
  const resume = await request.post(`/api/v1/agents/${id}/start`, {
    headers: authHeaders(),
  });
  expect(resume.ok(), await resume.text()).toBe(true);
  expect(
    JSON.parse(guest("scratch", `cat /var/lib/runner/hosts/${id}/launch.json`))
      .cwd
  ).toBe(selected);
  await newSettledTurn(
    page,
    "proof-count selected-cwd",
    "Local or guest fixture turn completed."
  );
  expect(guest("scratch", `cat ${selected}/provider-invocations`).trim()).toBe(
    "called"
  );

  const viewport = page.viewportSize()!;
  for (const size of [viewport, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await page.goto(`/agents/${id}/files`, { waitUntil: "domcontentloaded" });
    const files = page.getByTestId("files-pane");
    await files.getByText("selected-checkout.txt", { exact: true }).click();
    await expect(files).toContainText("Selected on the enrolled runner");
    await testInfo.attach(`selected checkout files at ${size.width}px`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  }
  await page.setViewportSize(viewport);

  await page.goto("/settings/runners", { waitUntil: "domcontentloaded" });
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
  const expand = page.getByTestId(`agent-expand-toggle-${id}`);
  if ((await expand.getAttribute("aria-expanded")) !== "true")
    await expand.click();
  await archive.click();
  await page.getByTestId("delete-agent-confirm").click();
  const choice = page.getByRole("alertdialog").filter({
    has: page.getByTestId("delete-agent-force-worktree"),
  });
  await expect(
    choice.getByText("?? provider-invocations", { exact: true })
  ).toBeVisible();
  await testInfo.attach("runner-owned scratch archive choice", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await choice.getByTestId("delete-agent-force-worktree").click();
  await expect(page.getByTestId(`agent-card-${id}`)).toHaveCount(0);
  await expect
    .poll(() => guestOk("scratch", `test ! -e ${directory}`), {
      timeout: 30_000,
    })
    .toBe(true);
  expect(guestOk("scratch", `test -f ${selected}/selected-checkout.txt`)).toBe(
    true
  );
});
