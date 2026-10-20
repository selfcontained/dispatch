import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("template modifiers prefill, select, clear, and enforce required inputs", async ({
  page,
  request,
}) => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-template-vars-"));
  const headers = {
    Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
  };
  const created = await request.post("/api/v1/templates", {
    headers,
    data: {
      name: `Variable modifiers ${Date.now()}`,
      directory,
      agentType: "codex",
      prompt:
        "{{D:Branch|default=main}} {{D:Notes|default=Release notes|multiline}} {{D:Environment|multiline|default=staging|required|options=dev,staging,production}} {{D:Region|options=East,West|default=East}} {{D:Target|required}}",
    },
  });
  expect(created.ok()).toBeTruthy();
  const template = await created.json();
  try {
    const invalid = await request.post(
      `/api/v1/templates/${template.id}/launch`,
      { headers, data: { args: { target: "api", environment: "other" } } }
    );
    expect(invalid.status()).toBe(400);
    expect((await invalid.json()).error).toContain(
      "choose one of dev, staging, production"
    );
    await page.goto("/automations", { waitUntil: "domcontentloaded" });
    const row = page
      .getByRole("button")
      .filter({ has: page.getByText(template.name, { exact: true }) });
    await row.hover();
    await row.getByTitle("Launch template").click();
    await expect(page.getByLabel("Branch", { exact: true })).toHaveValue(
      "main"
    );
    await expect(page.getByLabel("Notes", { exact: true })).toHaveValue(
      "Release notes"
    );
    await expect(
      page.getByRole("combobox", { name: "Environment" })
    ).toHaveText("staging");
    await expect(
      page.getByRole("button", { name: "Launch", exact: true })
    ).toBeDisabled();
    await page.getByLabel("Target").fill("api");
    await page.getByRole("combobox", { name: "Environment" }).click();
    await page.getByRole("option", { name: "production", exact: true }).click();
    await page.getByRole("button", { name: "Clear Region" }).click();
    await expect(page.getByRole("combobox", { name: "Region" })).toHaveText(
      "Choose Region"
    );
    await page.getByRole("combobox", { name: "Region" }).click();
    await page.getByRole("option", { name: "West", exact: true }).click();
    await page.getByRole("button", { name: "Clear Region" }).click();
    await page.getByLabel("Branch", { exact: true }).fill("");
    await expect(
      page.getByRole("button", { name: "Launch", exact: true })
    ).toBeEnabled();
    await page.getByRole("combobox", { name: "Environment" }).click();
    await page.getByRole("option", { name: "dev", exact: true }).click();
    const launch = page.waitForRequest(
      (r) =>
        r.url().endsWith(`/templates/${template.id}/launch`) &&
        r.method() === "POST"
    );
    await page.getByRole("button", { name: "Launch", exact: true }).click();
    expect((await launch).postDataJSON().args).toEqual({
      branch: "",
      notes: "Release notes",
      environment: "dev",
      region: "",
      target: "api",
    });
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    await request.delete(`/api/v1/templates/${template.id}`, { headers });
    rmSync(directory, { recursive: true, force: true });
  }
});
