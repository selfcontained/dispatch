import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { authHeaders, trackAgent } from "../helpers";

export type RunnerName = "alpha" | "beta";
type GuestName = RunnerName | "scratch";
type State = {
  controlPort: number;
  runnerPort: number;
  endpointHost: string;
  workspace: string;
  runners: Record<
    GuestName,
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
export function guest(name: GuestName, script: string) {
  return docker("exec", state.runners[name].container, "sh", "-c", script);
}
export function guestOk(name: GuestName, script: string) {
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

export function guestDiagnostics(name: GuestName) {
  const container = state.runners[name].container;
  const status = docker(
    "inspect",
    "--format",
    "status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}",
    container
  );
  try {
    const processes = guest(
      name,
      "ps -A -o pid,ppid,stat,comm; cat /sys/fs/cgroup/memory.events 2>/dev/null || true"
    );
    const journals = guest(
      name,
      "if [ -d /var/lib/runner/hosts ]; then find /var/lib/runner/hosts -name journal.jsonl -exec tail -n 8 {} +; fi"
    )
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => {
        const { seq, journalId, event } = JSON.parse(line);
        return `agent=${event?.agentId} journal=${journalId} seq=${seq} event=${event?.type} ${event?.state ?? ""}`.trimEnd();
      })
      .join("\n");
    const calls =
      name === "scratch"
        ? guest(
            name,
            "if [ -d /var/lib/runner/sessions ]; then find /var/lib/runner/sessions -name provider-invocations -exec wc -l {} +; fi"
          ).trim()
        : String(invocations(name));
    const logs = guest(
      name,
      'for file in /var/log/runner.log /var/lib/runner/bindings/logs/*; do [ ! -f "$file" ] || { printf "\\n%s\\n" "$file"; tail -60 "$file"; }; done'
    );
    return `${status}${processes}\nInvocation counts: ${calls}\n${journals}\n${logs}`;
  } catch {
    return `${status}Guest diagnostics unavailable.\n`;
  }
}

/** Fault injection on the runner's TCP path (TLS stays end to end). */
export async function lane(
  name: GuestName,
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

async function connectCommand(page: Page) {
  await page.goto("/settings/runners", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Add runner", exact: true }).click();
  const command = page.getByTestId("runner-connect-command");
  await expect(command).toContainText("dispatch-runner connect");
  const text = (await command.innerText()).trim();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  return text;
}

export async function requestConnection(
  page: Page,
  name: GuestName,
  dir = "/etc/dispatch-runner"
) {
  const command = await connectCommand(page);
  const match = /^sudo dispatch-runner connect '(https:\/\/[^']+)'$/.exec(
    command
  );
  expect(match, "Settings supplies exactly one service URL").toBeTruthy();
  const service = new URL(match![1]!);
  if (Number(service.port) === state.runnerPort)
    service.port = String(state.runners[name].proxyPort);
  const args = [
    "exec",
    state.runners[name].container,
    "/opt/bin/dispatch-runner",
    "connect",
    service.href,
    "--dir",
    dir,
    ...(dir === "/etc/dispatch-runner"
      ? ["--config", "/run/cfg/runner.json"]
      : []),
  ];
  let output = "";
  let failure: Error | null = null;
  const finished = new Promise<boolean>((resolve) => {
    const child = execFile(
      "docker",
      args,
      { timeout: 75_000 },
      (error, _stdout, stderr) => {
        failure = error
          ? new Error(`Runner connect failed: ${stderr.trim() || error.code}`)
          : null;
        resolve(error === null);
      }
    );
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
    });
  });
  const approval = () => {
    const code = /^Code: ([A-Z0-9_-]+)\r?$/im.exec(output)?.[1];
    const reference = /^Request: ([A-Z0-9_-]+)\r?$/im.exec(output)?.[1];
    return code && reference ? { code, reference } : undefined;
  };
  await expect
    .poll(
      () => {
        if (failure) throw failure;
        return approval();
      },
      { timeout: 20_000 }
    )
    .toBeTruthy();
  const { code, reference } = approval()!;
  expect(output).toContain(
    `Approve at: ${new URL("/settings/runners", page.url()).href}`
  );
  const label = `Review request ${reference}`;
  const review = page.getByRole("button", { name: label, exact: true });
  await expect(review).toBeVisible({ timeout: 15_000 });
  await review.click();
  const form = page
    .getByRole("dialog", { name: label, exact: true })
    .getByTestId("runner-approval");
  await expect(form).toBeVisible();
  return { form, code, finished };
}

export function startRunner(name: GuestName) {
  const proxyPort = state.runners[name].proxyPort;
  // The approved config records the advertised service port. Redirect only
  // that endpoint so chaos injection still covers the mTLS supervisor.
  guest(
    name,
    `sed -i -E '/"endpoint":/s/:${state.runnerPort}"/:${proxyPort}"/' /run/cfg/runner.json && grep -q ':${proxyPort}"' /run/cfg/runner.json`
  );
  docker(
    "exec",
    "-d",
    state.runners[name].container,
    "sh",
    "-c",
    "echo $$ > /run/runner-fixture.pid; exec /opt/bin/dispatch-runner remote-runner /run/cfg/runner.json >>/var/log/runner.log 2>&1"
  );
}

/** Crash only the fixture supervisor. Its independent ACP process stays alive. */
export function crashRunner(name: GuestName) {
  guest(
    name,
    `set -eu
    pid=$(cat /run/runner-fixture.pid)
    test "$pid" -gt 1
    test "$(readlink /proc/$pid/exe)" = /opt/bin/dispatch-runner
    test "$(tr '\\000' ' ' </proc/$pid/cmdline)" = "/opt/bin/dispatch-runner remote-runner /run/cfg/runner.json "
    kill -KILL "$pid"`
  );
}

export async function enrollViaUi(
  page: Page,
  request: APIRequestContext,
  name: GuestName
) {
  const { form, code, finished } = await requestConnection(page, name);
  await form.getByLabel("Runner name").fill(name);
  await form.getByLabel("Pairing code").fill(code);
  await form.getByRole("button", { name: "Approve runner" }).click();
  expect(await finished).toBe(true);
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
  await page.goto("/settings/runners", { waitUntil: "domcontentloaded" });
  await page.getByTestId(`runner-select-${id}`).click();
  await page.getByTestId(`runner-actions-${id}`).click();
  await page.getByTestId(`runner-revoke-${id}`).click();
  await page.getByTestId(`runner-revoke-confirm-${id}`).click();
  await page.getByText(/^Revoked runners \(/).click();
  await expect(page.getByTestId(`runner-status-${id}`)).toHaveText("Revoked", {
    timeout: 15_000,
  });
}

/** Launch through the normal Create Agent dialog (Folder = runner locator). */
export async function launchViaUi(
  page: Page,
  opts: {
    name: string;
    cwd?: string;
    runnerId?: string;
    managedScratch?: boolean;
    repository?: string;
    pullRequest?: string;
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
    if (opts.managedScratch || opts.repository) {
      await expect(
        page.getByTestId("create-agent-runner-workspace")
      ).toHaveCount(0);
      const picker = page.getByTestId("runner-repository");
      await expect(picker).toContainText("Choose a project or repository");
      if (opts.repository) {
        await picker.click();
        await page
          .getByRole("combobox", { name: "Search projects or repositories" })
          .fill(opts.repository);
        await page
          .getByRole("option", { name: opts.repository, exact: true })
          .click();
        if (opts.pullRequest) {
          await page
            .getByRole("combobox", { name: "Branch", exact: true })
            .click();
          await page
            .getByRole("option", { name: "Use an existing branch or PR" })
            .click();
          await page
            .getByLabel("Branch or pull request")
            .fill(opts.pullRequest);
        }
      }
    } else {
      await page.getByTestId("create-agent-runner-workspace").click();
      await page
        .getByRole("option", { name: state.workspace, exact: true })
        .click();
    }
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
