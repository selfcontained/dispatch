import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { authHeaders, deleteAgentViaAPI, trackAgent } from "../helpers";
import {
  enrollViaUi,
  guest,
  guestOk,
  runnerRow,
  settledTurns,
  state,
} from "./harness";

function installFixture(name: "beta" | "scratch") {
  const container = state.runners[name].container;
  const files = [
    ["fixture-gh.sh", "fixture-gh"],
    ["github-fixture.sh", "github-fixture.sh"],
  ];
  if (name === "scratch")
    files.push(["github-fixture-server.cjs", "github-server.cjs"]);
  for (const [source, target] of files) {
    execFileSync("docker", [
      "cp",
      resolve("e2e/remote-runner", source!),
      container + ":/tmp/" + target,
    ]);
  }
  guest(name, "sh /tmp/github-fixture.sh " + name);
  if (name === "scratch") {
    execFileSync("docker", [
      "exec",
      "-d",
      container,
      "node",
      "/tmp/github-server.cjs",
    ]);
  }
}

test("GitHub sign-in, private checkout and sign-out belong to the selected runner", async ({
  page,
  request,
}, testInfo) => {
  const ids = new Map<string, string>();
  for (const name of ["scratch", "beta"] as const) {
    installFixture(name);
    const row = await runnerRow(request, name);
    ids.set(name, row?.id ?? (await enrollViaUi(page, request, name)));
  }
  const openAccount = async (name: "scratch" | "beta") => {
    await page.goto("/settings/runners", { waitUntil: "domcontentloaded" });
    await page.getByTestId("runner-select-" + ids.get(name)).click();
    return page.getByTestId("runner-github");
  };
  // Bookmarks from the earlier pairing flow still lead to the runner list.
  await page.goto("/settings/connections", { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: "Manage runners" }).click();
  await expect(page).toHaveURL(/\/settings\/runners$/);
  await page.getByTestId("runner-select-" + ids.get("scratch")).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("runner"))
    .toBe(ids.get("scratch"));
  await page.reload({ waitUntil: "domcontentloaded" });
  let account = page.getByTestId("runner-detail").getByTestId("runner-github");
  await account.getByRole("button", { name: "Sign in to GitHub" }).click();
  await expect(account.getByText("B123-C456", { exact: true })).toBeVisible();
  await expect(
    account.getByRole("link", { name: "Open GitHub" })
  ).toHaveAttribute("href", "https://github.com/login/device");
  await testInfo.attach(
    "GitHub asks for approval on the selected test runner",
    {
      body: await page.getByTestId("runner-detail").screenshot(),
      contentType: "image/png",
    }
  );
  await account.getByRole("button", { name: "Cancel sign-in" }).click();
  await expect(
    account.getByRole("button", { name: "Sign in to GitHub" })
  ).toBeVisible();
  for (const name of ["beta", "scratch"] as const) {
    account = await openAccount(name);
    await account.getByRole("button", { name: "Sign in to GitHub" }).click();
    await expect(account.getByText("B123-C456", { exact: true })).toBeVisible();
    guest(name, "touch /tmp/github-fixture-approved");
    await expect(
      account.getByText("Signed in as @fixture-" + name)
    ).toBeVisible();
  }

  const projectName = "Private checkout project";
  const project = await request.post("/api/v1/projects", {
    headers: authHeaders(),
    data: {
      name: projectName,
      color: "#64748b",
      repository: "https://github.com/fixture-scratch/private",
    },
  });
  expect(project.ok(), await project.text()).toBe(true);

  const projectId = (await project.json()).id;
  // The shared form follows main's listed-branch picker. PR URLs remain an
  // API launch input; exercise the actual picker before launching that case.
  const targets = await request.get("/api/v1/launch-targets", {
    headers: authHeaders(),
  });
  const target = (await targets.json()).targets.find(
    (item: { selectionFields: { runner?: string } }) =>
      item.selectionFields.runner === ids.get("scratch")
  );
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("create-agent-button").click();
  await page.getByTestId("create-agent-runner").click();
  await page.getByTestId(`create-agent-runner-option-${target.key}`).click();
  await page.getByTestId("create-agent-runner-project").click();
  await page.getByRole("option", { name: projectName, exact: true }).click();
  await page.getByTestId("create-agent-base-branch").click();
  await page.getByRole("option", { name: "review-topic", exact: true }).click();
  await expect(page.getByTestId("create-agent-base-branch")).toHaveText(
    "review-topic"
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const launched = await request.post("/api/v1/agents", {
    headers: authHeaders(),
    data: {
      runner: ids.get("scratch"),
      projectId,
      type: "claude",
      useWorktree: true,
      createNewBranch: false,
      fullAccess: true,
      baseBranch: "https://github.com/fixture-scratch/private/pull/42",
      name: "Private checkout",
      initialPrompt: "proof-reviewed-checkout post-private-pr",
    },
  });
  expect(launched.status(), await launched.text()).toBe(201);
  const { agent } = await launched.json();
  if (agent.id) trackAgent(agent.id);
  expect(agent.id).toBeTruthy();
  try {
    await page.goto("/agents/" + agent.id, { waitUntil: "domcontentloaded" });
    await expect(
      settledTurns(page).getByTestId("harness-result")
    ).toContainText("Checkout marker private PR on scratch", {
      timeout: 45000,
    });
    await page
      .getByRole("button", { name: /Details for pull request #42: Open/i })
      .click();
    const details = page.getByRole("dialog").filter({
      has: page.getByRole("heading", { name: "Pull request #42", exact: true }),
    });
    await expect(details.getByText("build", { exact: true })).toBeVisible();
    guest("scratch", "touch /tmp/runner-ci-finished");
    // Main's background interval is five minutes. Exercise the normal refresh
    // action rather than asserting a shorter background schedule.
    await details
      .getByRole("button", { name: "Refresh pull request checks" })
      .click();
    await expect(details.getByText("integration", { exact: true })).toBeVisible(
      { timeout: 45_000 }
    );
    const screenshot = testInfo.outputPath("runner-private-pr-checks.png");
    await page.screenshot({ path: screenshot });
    await testInfo.attach("Open PR card received checks from the runner", {
      path: screenshot,
      contentType: "image/png",
    });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("button", { name: "Open sidebar", exact: true })
      .click();
    await page
      .getByRole("button", { name: /Details for pull request #42: Open/i })
      .click();
    guest("scratch", "rm /tmp/runner-ci-finished");
    await details
      .getByRole("button", { name: "Refresh pull request checks" })
      .click();
    await expect(details.getByText("build", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    const mobileScreenshot = testInfo.outputPath(
      "runner-private-pr-mobile-refresh.png"
    );
    await page.screenshot({ path: mobileScreenshot });
    await testInfo.attach("Manual runner refresh on mobile", {
      path: mobileScreenshot,
      contentType: "image/png",
    });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1280, height: 720 });
    // Uses the ordinary workload user's installed helper, independent of the provisioning helper.
    const fetch =
      "setpriv --reuid 1500 --regid 1500 --clear-groups env HOME=/home/guest GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/fixture-scratch/private.git HEAD";
    expect(guest("scratch", fetch)).toMatch(/^[a-f0-9]{40}\s+HEAD/);
    account = await openAccount("scratch");
    await account.getByRole("button", { name: "Sign out" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Sign out" })
      .click();
    await expect(
      account.getByRole("button", { name: "Sign in to GitHub" })
    ).toBeVisible();
    expect(guestOk("scratch", fetch + " >/dev/null 2>&1")).toBe(false);
    await page.goto("/agents/" + agent.id, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("button", {
        name: /Details for pull request #42: Unavailable/i,
      })
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      (await openAccount("beta")).getByText("Signed in as @fixture-beta")
    ).toBeVisible();
  } finally {
    if (agent.id) await deleteAgentViaAPI(request, agent.id);
  }
});
