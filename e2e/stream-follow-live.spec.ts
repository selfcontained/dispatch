import { randomUUID } from "node:crypto";

import { expect, type Page, test } from "@playwright/test";
import { Pool } from "pg";

import { callMcpToolViaAPI, createAgentViaAPI } from "./helpers";

// The live fake ACP runtime exercises row shrink/regrowth and composer
// resizing after sends, which inert posts alone cannot reproduce.
test.skip(process.env.DISPATCH_AGENT_RUNTIME !== "acp", "live only");

async function seedPosts(streamId: string, count: number) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const now = Date.now();
  try {
    for (let i = 0; i < count; i += 1) {
      const text = Array.from(
        { length: 1 + (i % 7) },
        (_, n) => `Post ${i} line ${n}: filler.`
      ).join("\n\n");
      const at = new Date(now - (count - i) * 60_000).toISOString();
      await pool.query(
        `INSERT INTO blocks (id, stream_id, author_kind, author_agent_id, kind, text, created_at, updated_at)
         VALUES ($1, $2, 'agent', $2, 'text', $3, $4, $4)`,
        [randomUUID(), streamId, text, at]
      );
    }
  } finally {
    await pool.end();
  }
}

async function state(page: Page, label: string) {
  const s = await page.getByTestId("chat-scroll").evaluate((el) => ({
    dist: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop),
    top: Math.round(el.scrollTop),
    h: el.scrollHeight,
    jump: !!document.querySelector('[data-testid="chat-jump-to-bottom"]'),
    rows: [...el.querySelectorAll<HTMLElement>('[data-testid="chat-message"]')]
      .slice(-4)
      .map((n) => ({
        top: n.getBoundingClientRect().top - el.getBoundingClientRect().top,
        body: n
          .querySelector('[data-testid="chat-turn-body"]')
          ?.getBoundingClientRect().height,
      })),
    pending:
      document
        .querySelector('[data-testid="chat-jump-to-bottom"]')
        ?.getAttribute("data-pending") ?? null,
  }));
  console.log(`[${label}]`, JSON.stringify(s));
  const trace = await page.evaluate(() => {
    const trace = (window as unknown as { followTrace: unknown[] }).followTrace;
    return trace.splice(0);
  });
  await test.info().attach(`scroll geometry ${label}`, {
    body: JSON.stringify(trace),
    contentType: "application/json",
  });
  if (label === "B settled" && page.viewportSize()?.width === 390) {
    // With a post below it, this reply would put its header above the
    // fold. Preserve the deliberate reply-start anchor at narrow width.
    const reply = s.rows.find((row) => row.body !== undefined && row.top >= 0);
    expect(reply?.top, label).toBeGreaterThanOrEqual(7);
    expect(reply?.top, label).toBeLessThanOrEqual(9);
    expect(s.pending, label).not.toBe("true");
  } else if (/^[ABD] /.test(label)) {
    expect(s.dist, label).toBeLessThanOrEqual(2);
    expect(s.pending, label).not.toBe("true");
  }
  return s;
}

async function send(page: Page, text: string) {
  const input = page.getByTestId("chat-composer-input");
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await input.fill(text);
  await page.getByTestId("chat-composer-send").click();
}

for (const width of [390, 1280]) {
  test(`live stream follows after send at width ${width}`, async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    await page.addInitScript(() => {
      const trace: {
        source: string;
        top: number;
        height: number;
        client: number;
      }[] = [];
      (window as unknown as { followTrace: typeof trace }).followTrace = trace;
      const sample = (source: string) => {
        const el = document.querySelector('[data-testid="chat-scroll"]');
        if (!el) return;
        trace.push({
          source,
          top: el.scrollTop,
          height: el.scrollHeight,
          client: el.clientHeight,
        });
      };
      const descriptor = Object.getOwnPropertyDescriptor(
        Element.prototype,
        "scrollTop"
      )!;
      Object.defineProperty(Element.prototype, "scrollTop", {
        configurable: true,
        get: descriptor.get,
        set(value) {
          if ((this as Element).getAttribute("data-testid") === "chat-scroll") {
            sample(`set top ${value}`);
          }
          descriptor.set!.call(this, value);
        },
      });
      const NativeObserver = window.ResizeObserver;
      window.ResizeObserver = class extends NativeObserver {
        constructor(callback: ResizeObserverCallback) {
          super((entries, observer) => {
            sample("resize before");
            callback(entries, observer);
            sample("resize after");
          });
        }
      };
      document.addEventListener("scroll", () => sample("scroll"), true);
    });
    await page.setViewportSize({ width, height: 800 });
    const agent = await createAgentViaAPI(request, {
      name: `repro-${Date.now()}`,
      type: "claude",
    });
    await seedPosts(agent.id, 100);
    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("chat-composer-input")).toBeEnabled({
      timeout: 30_000,
    });
    await page.waitForTimeout(1000);
    await state(page, "start");

    await send(page, "short hello");
    await expect(page.getByText(/You said:[\s\S]*short hello/)).toBeVisible({
      timeout: 30_000,
    });
    await page.waitForTimeout(1500);
    await state(page, "A short reply settled");

    await callMcpToolViaAPI(request, agent.id, "post", {
      text: "Post after short reply",
    });
    await page.getByText("Post after short reply", { exact: true }).waitFor();
    await page.waitForTimeout(700);
    await state(page, "A post after reply");

    await send(page, "run:2000 tool turn");
    await page.waitForTimeout(700);
    await callMcpToolViaAPI(request, agent.id, "post", {
      text: "Mid-turn post one",
    });
    await page.waitForTimeout(700);
    await state(page, "B mid-turn post");
    await expect(
      page.getByText(/You said:[\s\S]*run:2000 tool turn/)
    ).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    await state(page, "B settled");

    const long = Array.from({ length: 60 }, (_, i) => `Long line ${i}`).join(
      "\n\n"
    );
    await send(page, long);
    await expect(page.getByText("Long line 59").last()).toBeAttached({
      timeout: 30_000,
    });
    await page.waitForTimeout(2000);
    await state(page, "C tall reply settled");
    await callMcpToolViaAPI(request, agent.id, "post", {
      text: "After tall reply post",
    });
    await page.waitForTimeout(1500);
    await state(page, "C post after tall");

    await send(page, "sleep:3000 then reply");
    await page.waitForTimeout(800);
    await callMcpToolViaAPI(request, agent.id, "post", {
      text: "Posted while sleeping",
    });
    await page.waitForTimeout(800);
    await state(page, "D post while sleeping");
    await expect(
      page.getByText(/You said:[\s\S]*sleep:3000 then reply/)
    ).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    await state(page, "D settled");
    await page.screenshot({ path: `/tmp/repro-${width}.png` });
  });
}
