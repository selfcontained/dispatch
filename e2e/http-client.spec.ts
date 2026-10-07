import { expect, test } from "@playwright/test";
import { cleanupE2EAgents, createAgentViaAPI } from "./helpers";

// HTTP localhost is considered secure. Use a non-localhost hostname mapped to
// loopback to exercise the APIs actually available on plain HTTP LAN installs.
test.use({
  launchOptions: {
    args: [
      "--host-resolver-rules=MAP dispatch-http.test 127.0.0.1",
      "--no-proxy-server",
    ],
  },
  deviceScaleFactor: 2,
});

test.afterEach(async ({ request }) => {
  await cleanupE2EAgents(request);
});

for (const layout of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`sends and recovers from ID failures over insecure HTTP (${layout.name})`, async ({
    page,
    request,
    baseURL,
  }) => {
    test.skip(
      new URL(baseURL!).protocol !== "http:",
      "Plain HTTP crypto coverage requires an HTTP server; manual TLS runs use HTTPS."
    );
    await page.setViewportSize(layout);
    const agent = await createAgentViaAPI(request);
    const url = new URL(`/agents/${agent.id}`, baseURL);
    url.hostname = "dispatch-http.test";
    await page.goto(url.href, { waitUntil: "domcontentloaded" });
    const input = page.getByTestId("chat-composer-input");
    const send = page.getByTestId("chat-composer-send");
    await expect(input).toBeVisible();
    expect(
      await page.evaluate(() => ({
        secure: isSecureContext,
        randomUUID: typeof crypto.randomUUID,
        randomBytes: typeof crypto.getRandomValues,
      }))
    ).toEqual({
      secure: false,
      randomUUID: "undefined",
      randomBytes: "function",
    });

    const message = `Plain HTTP send (${layout.name})`;
    await input.fill(message);
    const posted = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/streams/${agent.id}/blocks`) &&
        response.request().method() === "POST"
    );
    await send.click();
    const response = await posted;
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON().id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    await expect(input).toHaveText("");
    await expect(
      page.getByTestId("chat-message").filter({ hasText: message })
    ).toBeVisible();

    // Even an unexpected random source failure must leave the draft retryable.
    await page.evaluate(() => {
      const original = crypto.getRandomValues.bind(crypto);
      crypto.getRandomValues = () => {
        crypto.getRandomValues = original;
        throw new Error("Random source unavailable");
      };
    });
    await input.fill("Retry this draft");
    await send.click();
    await expect(page.getByTestId("chat-composer-error")).toContainText(
      "Random source unavailable"
    );
    await expect(input).toHaveText("Retry this draft");
    await expect(send).toBeEnabled();
    await send.click();
    await expect(
      page.getByTestId("chat-message").filter({ hasText: "Retry this draft" })
    ).toBeVisible();
    await expect(input).toHaveText("");
    await expect(page.getByTestId("chat-composer-error")).toHaveCount(0);
    await page.screenshot({
      path: `/tmp/dispatch-http-${layout.name}.png`,
      fullPage: true,
    });
  });
}
