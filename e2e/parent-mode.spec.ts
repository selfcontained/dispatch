import { expect, test } from "@playwright/test";
import {
  callMcpToolViaAPI,
  cleanupE2EAgents,
  clickAgentRow,
  createAgentViaAPI,
  loadApp,
} from "./helpers";

test.afterEach(async ({ request }) => {
  await cleanupE2EAgents(request);
});

test("Parent conversation keeps review findings and hides other child posts", async ({
  page,
  request,
}) => {
  const parent = await createAgentViaAPI(request);
  const child = await createAgentViaAPI(request, { parentAgentId: parent.id });
  await callMcpToolViaAPI(request, parent.id, "post", {
    text: "Parent talking to you",
  });
  await callMcpToolViaAPI(request, parent.id, "post", {
    to: child.id,
    text: "Private builder instructions",
  });
  await callMcpToolViaAPI(request, child.id, "post", {
    to: parent.id,
    text: "Private builder progress",
  });
  await callMcpToolViaAPI(request, child.id, "post", {
    to: parent.id,
    review: {
      summary: "Useful completed review",
      findings: [
        {
          severity: "minor",
          title: "An inspectable finding",
          body: "The finding details remain available.",
          path: "example.ts",
          line: 12,
        },
      ],
    },
  });
  await loadApp(page);
  await clickAgentRow(page, parent.id);
  const pane = page.getByTestId("chat-pane");
  await page.getByTestId("chat-filters-trigger").click();
  const toggle = page.getByRole("switch", { name: "Show child messages" });
  await expect(toggle).not.toBeChecked();
  await page.keyboard.press("Escape");
  const launch = pane
    .getByTestId("chat-compact-launch")
    .filter({ has: pane.page().getByTestId("compact-launch-review") });
  await expect(launch).toHaveCount(1);
  await expect(launch).toContainText("Launched");
  await expect(
    launch.getByTestId("launch-agent-details").getByRole("button")
  ).toHaveCount(0);
  await expect(launch.getByTestId("compact-launch-review")).toContainText(
    "Useful completed review"
  );
  await expect(pane.getByTestId("chat-review-block")).toHaveCount(1);
  await expect(
    pane.getByText("Private builder instructions", { exact: true })
  ).toHaveCount(0);
  await expect(
    pane.getByText("Private builder progress", { exact: true })
  ).toHaveCount(0);
  await expect(
    pane.getByText("Useful completed review", { exact: true })
  ).toBeVisible();
  await expect(
    pane.getByText("Parent talking to you", { exact: true })
  ).toBeVisible();
  await callMcpToolViaAPI(request, parent.id, "post", {
    text: "Here is the report I want you to inspect",
    link: { url: "https://example.com/final", title: "Parent report" },
  });
  await expect(
    pane.getByText("Parent report", { exact: true }).first()
  ).toBeVisible();
  await pane.getByTestId("chat-review-header").click();
  await expect(
    page.getByText("An inspectable finding", { exact: true })
  ).toBeVisible();
  await page
    .getByTestId("chat-review-finding-link")
    .filter({ visible: true })
    .click();
  await expect(
    page
      .getByText("The finding details remain available.", { exact: true })
      .first()
  ).toBeVisible();
  await page.getByTestId("drawer-close").click();
  // Child sharing remains internal, including newly posted items.
  await callMcpToolViaAPI(request, child.id, "post", {
    text: "Live deliverable",
    link: { url: "https://example.com/report", title: "Child report" },
  });
  await expect(pane.getByText("Child report", { exact: true })).toHaveCount(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(pane).toHaveAttribute("data-parent-mode", "true");
  await expect(
    pane.getByText("Useful completed review", { exact: true })
  ).toBeVisible();
  await expect(
    pane.getByText("Private builder instructions", { exact: true })
  ).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("parent-conversation.png"),
    animations: "disabled",
  });
  await page.getByTestId("chat-filters-trigger").click();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(
    pane.getByText("Private builder instructions", { exact: true })
  ).toBeVisible();
});
