import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { authHeaders, trackAgent } from "../helpers";

export type RunnerName = "alpha" | "beta";
type State = {
  controlPort: number;
  runnerPort: number;
  endpointHost: string;
  workspace: string;
  runners: Record<
    RunnerName,
    { container: string; proxyPort: number; workspaceDir: string }
  >;
};

// Assumption (enrollment slice): runner registry lives at /api/runners.
export const RUNNERS_API = "/api/runners";

export const state: State = JSON.parse(
  readFileSync(process.env.REMOTE_E2E_STATE ?? "/nonexistent", "utf8")
);

const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8" });

/** Run a shell command inside a runner container as root. */
export function guest(name: RunnerName, script: string) {
  return docker("exec", state.runners[name].container, "sh", "-c", script);
}
export function guestOk(name: RunnerName, script: string) {
  try {
    guest(name, script);
    return true;
  } catch {
    return false;
  }
}
export const marker = (name: RunnerName) =>
  guest(name, `cat ${state.runners[name].workspaceDir}/marker.txt`).trim();
export const invocations = (name: RunnerName) =>
  Number(
    guest(
      name,
      `cat ${state.runners[name].workspaceDir}/provider-invocations 2>/dev/null | wc -l`
    ).trim()
  );

/** Fault injection on the runner's TCP path (TLS stays end to end). */
export async function lane(
  name: RunnerName,
  action: "sever" | "block" | "allow" | "status"
) {
  const res = await fetch(
    `http://127.0.0.1:${state.controlPort}/${name}/${action}`,
    { method: action === "status" ? "GET" : "POST" }
  );
  return (await res.json()) as {
    blocked: boolean;
    open: number;
    accepted: number;
  };
}

export type RunnerRow = {
  id: string;
  name: string;
  status: string;
  workspaces?: string[];
};
export async function runnerRows(request: APIRequestContext) {
  const res = await request.get(RUNNERS_API, { headers: authHeaders() });
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { runners: RunnerRow[] }).runners;
}
export const runnerRow = async (request: APIRequestContext, name: string) =>
  (await runnerRows(request)).find((r) => r.name === name);

/** Route the runner's whole path (pairing and mTLS) through its chaos lane. */
const viaLane = (name: RunnerName, command: string) =>
  command.replace(
    /--endpoint\s+https:\/\/\S+/,
    `--endpoint https://${state.endpointHost}:${state.runners[name].proxyPort}`
  );

export async function createPairing(request: APIRequestContext, name: string) {
  const res = await request.post(RUNNERS_API, {
    headers: authHeaders(),
    data: { name },
  });
  return { res, body: res.ok() ? await res.json() : null } as {
    res: typeof res;
    body: { id: string; command: string; expiresAt: string } | null;
  };
}

/** Pair inside the container (key generated there), then start the runner. */
export function pairInContainer(
  name: RunnerName,
  command: string,
  dir = "/etc/dispatch-runner"
) {
  const c = state.runners[name].container;
  const pair = viaLane(name, command).replace(
    /^dispatch-runner/,
    "/opt/bin/dispatch-runner"
  );
  return docker(
    "exec",
    c,
    "sh",
    "-c",
    `${pair} --dir ${dir} ${dir === "/etc/dispatch-runner" ? "--config /run/cfg/runner.json" : ""} 2>&1`
  );
}
export function startRunner(name: RunnerName) {
  docker(
    "exec",
    "-d",
    state.runners[name].container,
    "sh",
    "-c",
    "/opt/bin/dispatch-runner remote-runner /run/cfg/runner.json >/var/log/runner.log 2>&1"
  );
}
export const runnerLog = (name: RunnerName) =>
  guest(name, "cat /var/log/runner.log 2>/dev/null || true");

/** Pair through Settings → Connections → Remote runners (the normal UI). */
export async function enrollViaUi(
  page: Page,
  request: APIRequestContext,
  name: RunnerName
) {
  await page.goto("/settings/connections", { waitUntil: "domcontentloaded" });
  await page.getByTestId("runner-name-input").fill(name);
  await page.getByTestId("runner-pair-submit").click();
  const command = (await page.getByTestId("runner-command").innerText()).trim();
  pairInContainer(name, command);
  startRunner(name);
  await expect
    .poll(async () => (await runnerRow(request, name))?.status, {
      timeout: 30_000,
    })
    .toBe("online");
  const id = (await runnerRow(request, name))!.id;
  await expect(page.getByTestId(`runner-status-${id}`)).toHaveText("Online", {
    timeout: 15_000,
  });
  return id;
}

export async function revokeViaUi(page: Page, id: string) {
  await page.goto("/settings/connections", { waitUntil: "domcontentloaded" });
  await page.getByTestId(`runner-revoke-${id}`).click();
  await page.getByTestId(`runner-revoke-confirm-${id}`).click();
  await expect(page.getByTestId(`runner-status-${id}`)).toHaveText("Revoked", {
    timeout: 15_000,
  });
}

export async function enroll(request: APIRequestContext, name: RunnerName) {
  const { res, body } = await createPairing(request, name);
  expect(res.ok(), await res.text()).toBe(true);
  pairInContainer(name, body!.command);
  startRunner(name);
  await expect
    .poll(async () => (await runnerRow(request, name))?.status, {
      timeout: 30_000,
    })
    .toBe("online");
  return body!.id;
}

/** Launch through the normal Create Agent dialog (Folder = runner locator). */
export async function launchViaUi(
  page: Page,
  opts: {
    name: string;
    cwd?: string;
    runnerId?: string;
    prompt: string;
    restricted?: boolean;
  }
) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("create-agent-button").click();
  await expect(page.getByTestId("create-agent-form")).toBeVisible();
  if (opts.runnerId)
    await expect(page.getByTestId("runner-picker")).toBeVisible({
      timeout: 15_000,
    });
  await page.getByTestId("create-agent-name").fill(opts.name);
  if (opts.runnerId) {
    // Runner picker (runner-picker.tsx): "Runs on" then "Workspace".
    await page.getByTestId("create-agent-runner").click();
    await page
      .getByTestId(`create-agent-runner-option-${opts.runnerId}`)
      .click();
    await page.getByTestId("create-agent-runner-workspace").click();
    await page
      .getByRole("option", { name: state.workspace, exact: true })
      .click();
  } else await page.getByTestId("create-agent-cwd").fill(opts.cwd ?? "/tmp");
  if (opts.restricted) {
    // "Start in full access mode" is on by default; permission prompts need it off.
    const full = page.getByTitle("Toggle full access");
    if ((await full.getAttribute("aria-checked")) === "true")
      await full.click();
    await expect(full).toHaveAttribute("aria-checked", "false");
  }
  await page.getByTestId("create-agent-with-context").click();
  await page.getByTestId("create-agent-initial-prompt").fill(opts.prompt);
  const created = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === "/api/v1/agents"
  );
  await page.getByTestId("create-agent-context-submit").click();
  const response = await created;
  const body = (await response.json()) as { agent?: { id: string } };
  if (body.agent) trackAgent(body.agent.id);
  return { status: response.status(), id: body.agent?.id };
}

export async function agentInfo(request: APIRequestContext, id: string) {
  const res = await request.get(`/api/v1/agents/${id}`, {
    headers: authHeaders(),
  });
  return (await res.json()).agent as {
    status: string;
    activity?: string;
    cwd: string;
  };
}

/** Send a follow-up chat message through the composer. */
export async function chat(page: Page, text: string) {
  const input = page.getByTestId("chat-composer-input");
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await input.fill(text);
  await page.getByTestId("chat-composer-send").click();
  await expect(input).toHaveText("");
}

/** Open the dialog and report whether a runner option can be selected. */
export async function runnerOptionEnabled(page: Page, runnerId: string) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("create-agent-button").click();
  await page.getByTestId("create-agent-runner").click();
  const option = page.getByTestId(`create-agent-runner-option-${runnerId}`);
  const enabled =
    (await option.count()) > 0 &&
    (await option.getAttribute("aria-disabled")) !== "true" &&
    (await option.getAttribute("data-disabled")) === null;
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  return enabled;
}

/** Direct API launch, for placements the dialog deliberately cannot express. */
export async function launchViaApi(request: APIRequestContext, cwd: string) {
  const res = await request.post("/api/v1/agents", {
    headers: authHeaders(),
    data: {
      name: `e2e-rr-api-${Date.now()}`,
      type: "codex",
      cwd,
      useWorktree: false,
      initialPrompt: "x",
    },
  });
  if (res.ok())
    trackAgent(((await res.json()) as { agent: { id: string } }).agent.id);
  return res.status();
}

/** Settled-turn counter: proves a NEW provider turn, not an old or echoed reply. */
export const settledTurns = (page: Page) =>
  page.locator('[data-testid="chat-turn"][data-settled="true"]');

/** Send `prompt` and require one additional settled turn whose answer contains every `expected`. */
export async function newSettledTurn(
  page: Page,
  prompt: string,
  expected: string | string[]
) {
  const before = await settledTurns(page).count();
  await chat(page, prompt);
  await expect(settledTurns(page)).toHaveCount(before + 1, { timeout: 45_000 });
  const result = settledTurns(page).last().getByTestId("harness-result");
  for (const text of [expected].flat())
    await expect(result).toContainText(text);
}
