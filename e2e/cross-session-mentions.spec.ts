import { expect, test } from "@playwright/test";
import {
  authHeaders,
  callMcpToolViaAPI,
  cleanupE2EAgents,
  createAgentViaAPI,
} from "./helpers";

test.afterEach(async ({ request }) => {
  await cleanupE2EAgents(request);
});

for (const width of [1280, 390]) {
  test(`mentions another parent session but excludes its children (${width})`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const suffix = Date.now();
    const source = await createAgentViaAPI(request, {
      name: `e2e-source-${suffix}`,
    });
    const target = await createAgentViaAPI(request, {
      name: `e2e-target-${suffix}`,
    });
    const child = await createAgentViaAPI(request, {
      name: `e2e-child-${suffix}`,
      parentAgentId: target.id,
    });
    const ownChild = await createAgentViaAPI(request, {
      name: `e2e-own-child-${suffix}`,
      parentAgentId: source.id,
    });
    await page.goto(`/agents/${source.id}`, { waitUntil: "domcontentloaded" });
    const input = page.getByTestId("chat-composer-input");
    await expect(input).toBeVisible();
    await input.fill("@");
    const picker = page.getByTestId("mention-picker");
    await expect(picker).toBeVisible();
    await expect(
      picker.locator(`[data-agent-id="${target.id}"]`)
    ).toBeVisible();
    await expect(
      picker
        .locator(`[data-agent-id="${target.id}"]`)
        .getByTestId("mention-session-icon")
    ).toBeVisible();
    await expect(
      picker.locator(`[data-agent-id="${ownChild.id}"]`)
    ).toBeVisible();
    await expect(picker.locator(`[data-agent-id="${child.id}"]`)).toHaveCount(
      0
    );
    const sessionBadge = picker
      .locator(`[data-agent-id="${target.id}"]`)
      .getByTestId("mention-session-icon");
    await expect(sessionBadge).toHaveClass(/bg-sky-500\/15/);
    await expect(sessionBadge).not.toHaveAttribute("data-seat");
    await expect(sessionBadge).not.toHaveAttribute("title");
    await page.screenshot({ path: `/tmp/cross-session-mentions-${width}.png` });
    await picker.locator(`[data-agent-id="${target.id}"]`).click();
    await expect(input).toHaveText(`@${target.name} `);
    await expect(page.getByLabel("Message recipients")).toContainText(
      target.name
    );
    await expect(
      page
        .getByTestId("chat-composer-recipient")
        .getByTestId("chat-avatar-agent")
    ).toHaveClass(/bg-sky-500\/15/);
    await expect(page.getByTestId("chat-composer-mention")).toHaveClass(
      /bg-sky-500\/15/
    );
    await page.screenshot({ path: `/tmp/cross-session-composer-${width}.png` });
    await input.press("End");
    await input.pressSequentially("please help");
    const sent = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/streams/${source.id}/blocks`)
    );
    await page.getByTestId("chat-composer-send").click();
    const response = await sent;
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.block.toAgentId).toBe(target.id);
    expect(body.block.data.mentions).toEqual([target.id]);
    expect(body.block.streamId).toBe(source.id);
    // An explicitly threaded agent response returns to the originating session.
    const responseText = `Cross-session response ${width}`;
    await callMcpToolViaAPI(request, target.id, "post", {
      text: responseText,
      replyTo: body.block.id,
    });
    await page
      .locator(`[data-block-id="${body.block.id}"]`)
      .getByTestId("chat-reply-in-thread")
      .click();
    const thread = page.locator('[data-testid="chat-thread-panel"]:visible');
    await expect(thread).toContainText(responseText);
    const responsePost = thread
      .locator("[data-block-id]")
      .filter({ hasText: responseText })
      .first();
    await expect(responsePost.getByTestId("chat-avatar-agent")).toHaveClass(
      /bg-sky-500\/15/
    );
    await expect(
      responsePost.getByTestId("chat-avatar-agent")
    ).not.toHaveAttribute("data-seat");
    await expect(responsePost.getByTestId("chat-avatar-agent")).toHaveAttribute(
      "title",
      target.name
    );
    await expect(page.getByTestId("chat-mention").first()).toHaveClass(
      /bg-sky-500\/15/
    );

    await callMcpToolViaAPI(request, target.id, "post", {
      text: "Please review this",
      to: child.id,
      replyTo: body.block.id,
    });
    const blocksResponse = await request.get(
      `/api/v1/streams/${source.id}/blocks/${body.block.id}/thread`,
      { headers: authHeaders() }
    );
    const threadData = await blocksResponse.json();
    const delegated = threadData.replies.find(
      (block: { id: string; text: string }) =>
        block.text === "Please review this"
    );
    expect(delegated).toBeTruthy();
    await callMcpToolViaAPI(request, child.id, "post", {
      text: "Child review complete",
      replyTo: delegated.id,
    });
    await expect(thread).toContainText("Child review complete");
    await expect
      .poll(async () => {
        const rect = await thread.boundingBox();
        return !!rect && rect.x >= 0 && rect.x + rect.width <= width + 1;
      })
      .toBeTruthy();
    await page.screenshot({ path: `/tmp/cross-session-response-${width}.png` });
    await page.keyboard.press("Escape");
    await expect(thread).toHaveCount(0);
    // Stopped external parents disappear from autocomplete too.
    const stopped = await request.post(`/api/v1/agents/${target.id}/stop`, {
      headers: authHeaders(),
    });
    expect(stopped.ok()).toBeTruthy();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(input).toBeVisible();
    await expect(
      page
        .locator(`[data-block-id="${body.block.id}"]`)
        .getByTestId("chat-mention")
    ).toContainText(target.name);
    await input.fill("@");
    await expect(picker.locator(`[data-agent-id="${target.id}"]`)).toHaveCount(
      0
    );
    await input.press("Escape");
    await expect(picker).toBeHidden();
    await page.screenshot({ path: `/tmp/mention-history-${width}.png` });
  });
}

for (const width of [1280, 390]) {
  test(`qualified names preserve selected sessions and tree mentions (${width})`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const suffix = Date.now();
    const source = await createAgentViaAPI(request, {
      name: `e2e-qualified-source-${suffix}`,
    });
    const own = await createAgentViaAPI(request, {
      name: `e2e-review-${suffix}`,
      parentAgentId: source.id,
    });
    const longer = await createAgentViaAPI(request, {
      name: `${own.name} fix`,
    });
    const older = await createAgentViaAPI(request, {
      name: `e2e-duplicate-${suffix}`,
    });
    const newer = await createAgentViaAPI(request, { name: older.name });
    await page.goto(`/agents/${source.id}`, { waitUntil: "domcontentloaded" });
    const input = page.getByTestId("chat-composer-input");
    await input.fill(`@${own.name} fix the flaky test`);
    await expect(
      page.getByLabel("Message recipients").getByLabel(`${own.name}, agent 2`)
    ).toBeVisible();
    const sendTo = async (id: string) => {
      const sent = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith(`/streams/${source.id}/blocks`)
      );
      await page.getByTestId("chat-composer-send").click();
      const response = await sent;
      expect(response.ok()).toBeTruthy();
      const body = await response.json();
      expect(body.block.toAgentId).toBe(id);
      expect(body.block.data.mentions).toEqual([id]);
      await expect(input).toBeEmpty();
    };
    await sendTo(own.id);
    for (const target of [older, newer, longer]) {
      await input.fill("@");
      const option = page
        .getByTestId("mention-picker")
        .locator(`[data-agent-id="${target.id}"]`);
      await expect(option).toBeVisible();
      await expect(option).toContainText(target.id.slice(-6));
      if (target.id === newer.id) {
        await page.screenshot({ path: `/tmp/qualified-mentions-${width}.png` });
      }
      await option.click();
      await expect(input).toHaveText(`@${target.name} [${target.id}] `);
      await sendTo(target.id);
    }
  });
}

for (const width of [1280, 390]) {
  test(`historical unaddressed text stays plain when another parent starts (${width})`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const suffix = Date.now();
    const source = await createAgentViaAPI(request, {
      name: `e2e-history-${suffix}`,
    });
    const futureName = `e2e-future-${suffix}`;
    await page.goto(`/agents/${source.id}`, { waitUntil: "domcontentloaded" });
    const input = page.getByTestId("chat-composer-input");
    await input.fill(`@${futureName} is ordinary text`);
    const sent = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/streams/${source.id}/blocks`)
    );
    await page.getByTestId("chat-composer-send").click();
    const body = await (await sent).json();
    expect(body.block.toAgentId).toBe(source.id);
    expect(body.block.data?.mentions).toBeUndefined();
    await createAgentViaAPI(request, { name: futureName });
    await page.reload({ waitUntil: "domcontentloaded" });
    const message = page.locator(`[data-block-id="${body.block.id}"]`);
    await expect(message).toContainText(futureName);
    await expect(message.getByTestId("chat-mention")).toHaveCount(0);
    await page.screenshot({
      path: `/tmp/mention-unaddressed-history-${width}.png`,
    });
  });
}
