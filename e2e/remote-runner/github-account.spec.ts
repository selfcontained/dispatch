import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { deleteAgentViaAPI } from "../helpers";
import {
  enrollViaUi,
  guest,
  guestOk,
  launchViaUi,
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
    await page.goto("/settings/connections", { waitUntil: "domcontentloaded" });
    await page.getByTestId("runner-select-" + ids.get(name)).click();
    return page.getByTestId("runner-github");
  };
  let account = await openAccount("scratch");
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

  const agent = await launchViaUi(page, {
    runnerId: ids.get("scratch"),
    repository: "fixture-scratch/private",
    pullRequest: "https://github.com/fixture-scratch/private/pull/42",
    name: "Private checkout",
    prompt: "proof-reviewed-checkout",
  });
  expect(agent.id).toBeTruthy();
  try {
    await page.goto("/agents/" + agent.id, { waitUntil: "domcontentloaded" });
    await expect(
      settledTurns(page).getByTestId("harness-result")
    ).toContainText("Checkout marker private checkout on scratch", {
      timeout: 45000,
    });
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
    await expect(
      (await openAccount("beta")).getByText("Signed in as @fixture-beta")
    ).toBeVisible();
  } finally {
    if (agent.id) await deleteAgentViaAPI(request, agent.id);
  }
});
