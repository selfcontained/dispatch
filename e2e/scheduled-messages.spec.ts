import { expect, test } from "@playwright/test";
import {
  authHeaders,
  cleanupE2EAgents,
  createAgentViaAPI,
  seedBlockViaDB,
} from "./helpers";
test.afterEach(async ({ request }) => {
  await cleanupE2EAgents(request);
});
for (const mobile of [false, true])
  test(`scheduled messages controls ${mobile ? "mobile" : "desktop"}`, async ({
    page,
    request,
  }) => {
    if (mobile) await page.setViewportSize({ width: 320, height: 844 });
    const agent = await createAgentViaAPI(request, {
      name: `Schedule UX ${Date.now()}`,
    });
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("scheduled-messages-trigger")).toHaveCount(0);
    const dialog = page.getByRole("dialog", { name: "Scheduled messages" });
    const response = await request.post(
      `/api/v1/agents/${agent.id}/scheduled-messages`,
      {
        headers: authHeaders(),
        data: {
          title: "Check deployment",
          message: "Check the deployment result",
          deliver_at: new Date(Date.now() + 60000).toISOString(),
          interval_seconds: 300,
          stop_when: "Deployment complete",
          max_deliveries: 20,
        },
      }
    );
    expect(response.ok()).toBeTruthy();
    const schedule = await response.json();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page
        .getByTestId("scheduled-message-entry")
        .getByText("Scheduled reminder", { exact: true })
    ).toBeVisible();
    await expect(page.getByTestId("scheduled-messages-trigger")).toHaveClass(
      /text-heading-accent-1/
    );
    await page.getByTestId("scheduled-messages-trigger").click();
    const row = dialog.getByTestId(`schedule-${schedule.id}`);
    await expect(
      dialog.getByRole("combobox", { name: "Choose scheduled message" })
    ).toContainText("Check deployment");
    await expect(
      row.getByText("Check the deployment result", { exact: true })
    ).toBeVisible();
    await row.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(
      row.getByRole("button", { name: "Resume", exact: true })
    ).toBeVisible();
    await expect(
      page.getByTestId("scheduled-messages-trigger")
    ).toHaveAttribute("aria-label", "Scheduled messages, 1 paused");
    await row.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(
      row.getByRole("button", { name: "Pause", exact: true })
    ).toBeVisible();
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)
    ).toBe(true);
    await page.screenshot({
      path: `/tmp/dispatch-scheduled-messages-${mobile ? "mobile" : "desktop"}.png`,
    });
    await row
      .getByRole("button", { name: "Cancel schedule", exact: true })
      .click();
    await expect(dialog.getByRole("status")).toHaveText(
      "Future deliveries cancelled."
    );
    await expect(
      dialog.getByText("No current schedules.", { exact: true })
    ).toBeVisible();
    await expect(row.getByText(/Cancelled ·/)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("scheduled-messages-trigger")).toHaveCount(0);
    await expect(page.getByTestId("chat-filters-trigger")).toBeFocused();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("scheduled-messages-trigger")).toHaveCount(0);
    await page
      .getByTestId("scheduled-message-entry")
      .getByRole("button", { name: "View schedule", exact: true })
      .click();
    await expect(row.getByText(/Cancelled ·/)).toBeVisible();
  });

test("scheduled messages keep uncertain access in split headers and distinguish deliveries", async ({
  page,
  request,
}) => {
  const agent = await createAgentViaAPI(request, {
    name: `Schedule split ${Date.now()}`,
  });
  const response = await request.post(
    `/api/v1/agents/${agent.id}/scheduled-messages`,
    {
      headers: authHeaders(),
      data: {
        title: "Deployment reminder",
        message: "Check the deployment result",
        deliver_at: new Date(Date.now() + 60000).toISOString(),
        interval_seconds: 300,
        stop_when: "Deployment complete",
        max_deliveries: 20,
      },
    }
  );
  expect(response.ok()).toBeTruthy();
  const schedule = await response.json();
  await seedBlockViaDB({
    streamId: agent.id,
    authorKind: "agent",
    toAgentId: agent.id,
    text: "Internal engine envelope",
    data: { scheduledMessageId: schedule.id, scheduledMessage: schedule },
    delivered: true,
  });
  await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
  await expect(
    page.getByText("Scheduled delivery", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText("Internal engine envelope", { exact: true })
  ).toHaveCount(0);
  await page.evaluate(
    (id) =>
      localStorage.setItem(
        `dispatch:splitPaneV2:${id}`,
        JSON.stringify({
          mode: "split",
          left: "agent",
          right: "changes",
          sizes: [50, 50],
        })
      ),
    agent.id
  );
  await page.route(
    `**/api/v1/agents/${agent.id}/scheduled-messages`,
    (route) =>
      route.request().method() === "GET"
        ? route.fulfill({
            json: [
              {
                ...schedule,
                status: "uncertain",
                error: "Delivery could not be confirmed",
              },
            ],
          })
        : route.continue()
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("unsplit-button")).toBeVisible();
  const clock = page.getByTestId("scheduled-messages-trigger");
  await expect(clock).toHaveAttribute(
    "aria-label",
    "Scheduled messages, 1 needing attention"
  );
  await clock.click();
  const dialog = page.getByRole("dialog", { name: "Scheduled messages" });
  await expect(
    dialog.getByText("Scheduling is suspended to avoid duplicates", {
      exact: true,
    })
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Resume", exact: true })
  ).toHaveCount(0);
  await page.screenshot({
    path: "/tmp/dispatch-scheduled-messages-split-uncertain.png",
  });
  await dialog
    .getByRole("button", { name: "Close scheduled messages", exact: true })
    .click();
});

test("schedule selection stays consistent and light theme text is readable", async ({
  page,
  request,
}) => {
  const agent = await createAgentViaAPI(request, {
    name: `Schedule selection ${Date.now()}`,
  });
  const schedules = [];
  for (const title of ["Watch background tests", "Check deployment progress"]) {
    const response = await request.post(
      `/api/v1/agents/${agent.id}/scheduled-messages`,
      {
        headers: authHeaders(),
        data: {
          title,
          message: `Message for ${title}`,
          deliver_at: new Date(Date.now() + 60000).toISOString(),
          max_deliveries: 1,
        },
      }
    );
    expect(response.ok()).toBeTruthy();
    schedules.push(await response.json());
  }
  await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("scheduled-messages-trigger").click();
  const dialog = page.getByRole("dialog", { name: "Scheduled messages" });
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const schedule of schedules) {
      const selector = dialog.getByRole("combobox", {
        name: "Choose scheduled message",
      });
      await selector.click();
      await page
        .getByRole("option", { name: schedule.title, exact: true })
        .click();
      await expect(selector).toContainText(schedule.title);
      await expect(dialog.getByRole("heading", { level: 3 })).toHaveText(
        schedule.title
      );
    }
  }
  await page.evaluate(() =>
    document.documentElement.setAttribute("data-theme", "light")
  );
  const contrast = await dialog.evaluate((el) => {
    const luminance = (color: string) => {
      const [r, g, b] = color
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number)
        .map((value) => {
          const v = value / 255;
          return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const background = luminance(getComputedStyle(el).backgroundColor);
    return Math.min(
      ...[...el.querySelectorAll("h2,h3,p,time")].map((text) => {
        const foreground = luminance(getComputedStyle(text).color);
        return (
          (Math.max(background, foreground) + 0.05) /
          (Math.min(background, foreground) + 0.05)
        );
      })
    );
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({
    path: "/tmp/dispatch-schedule-selection-light.png",
    animations: "disabled",
  });
  await dialog
    .getByRole("button", { name: "Close scheduled messages" })
    .click();
});

test("mobile ended-history dropdown keeps message visible and reveals the selected reminder", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const agent = await createAgentViaAPI(request, {
    name: `Schedule history ${Date.now()}`,
  });
  const schedules = [];
  for (let index = 1; index <= 22; index++) {
    const response = await request.post(
      `/api/v1/agents/${agent.id}/scheduled-messages`,
      {
        headers: authHeaders(),
        data: {
          title: `History reminder ${index}`,
          message: `Remember task ${index}.`,
          deliver_at: new Date(Date.now() + 60000).toISOString(),
        },
      }
    );
    expect(response.ok()).toBeTruthy();
    const schedule = await response.json();
    schedules.push(schedule);
    const cancel = await request.post(
      `/api/v1/agents/${agent.id}/scheduled-messages/${schedule.id}`,
      { headers: authHeaders(), data: { action: "cancel" } }
    );
    expect(cancel.ok()).toBeTruthy();
  }
  await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
  const dialog = page.getByRole("dialog", { name: "Scheduled messages" });
  const first = schedules[21];
  await page
    .getByTestId("scheduled-message-entry")
    .filter({
      has: page.getByRole("heading", { name: first.title, exact: true }),
    })
    .getByRole("button", { name: "View schedule" })
    .click();
  const selector = dialog.getByRole("combobox", {
    name: "Choose scheduled message",
  });
  const assertSelected = async (schedule: typeof first) => {
    await expect(selector).toContainText(schedule.title);
    await expect(selector).toBeInViewport();
    await expect(
      dialog.getByText(schedule.message, { exact: true })
    ).toBeInViewport();
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)
    ).toBeTruthy();
  };
  await assertSelected(first);
  await page.screenshot({
    path: "/tmp/dispatch-schedule-history-open-mobile.png",
    animations: "disabled",
  });
  await selector.click();
  await page
    .getByRole("option", {
      name: `${schedules[0].title} · Cancelled`,
      exact: true,
    })
    .click();
  await assertSelected(schedules[0]);
  await page.screenshot({
    path: "/tmp/dispatch-schedule-history-selected-mobile.png",
    animations: "disabled",
  });
  await dialog
    .getByRole("button", { name: "Close scheduled messages" })
    .click();
});
