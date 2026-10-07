#!/usr/bin/env node
// Measures the web app against a stream-stress stack (see drive.mjs) in
// Chromium: load and load-older scaling, interaction latency (typing,
// scrolling, opening a thread, switching agents, expanding steps and a
// review), and — while `drive.mjs live` runs — heap, DOM, main-thread time,
// long tasks and the SSE event/byte rate. One JSON line per sample.
//
//   node scripts/stream-stress/measure.mjs --web http://127.0.0.1:PORT \
//     --setup setup.json --label base [--older 3] [--live 90] [--api URL] \
//     [--cpu 1]
//
// Numbers are Chromium's (JS heap, CDP metrics, Event Timing). WebKit's
// graphics memory needs the WKWebView probe; see README.md here.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(here, "../../package.json"));
const { chromium } = require("playwright");

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (pairs, arg, i, all) =>
        arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs,
      []
    )
);
const WEB = args.web;
const LABEL = args.label ?? "run";
const setup = JSON.parse(readFileSync(args.setup, "utf8"));
const ROOT = setup.root;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const out = (row) => console.log(JSON.stringify({ label: LABEL, ...row }));
const pct = (list, p) => {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted.length
    ? Math.round(
        sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
      )
    : null;
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  serviceWorkers: "block",
});
await context.addInitScript(() => {
  // SSE traffic as the page receives it.
  const stats = { events: 0, bytes: 0, entryBytes: 0 };
  window.__sse = stats;
  const Native = window.EventSource;
  window.EventSource = class extends Native {
    constructor(...a) {
      super(...a);
      this.addEventListener("message", (event) => {
        stats.events += 1;
        stats.bytes += event.data.length;
        if (event.data.startsWith('{"type":"stream.entry"'))
          stats.entryBytes += event.data.length;
      });
    }
  };
  // Long tasks and slow interactions.
  window.__long = { count: 0, total: 0 };
  window.__events = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      window.__long.count += 1;
      window.__long.total += e.duration;
    }
  }).observe({ type: "longtask", buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries())
      window.__events.push({ name: e.name, duration: e.duration });
  }).observe({ type: "event", durationThreshold: 16, buffered: true });
});
const page = await context.newPage();
// Mark-read requests, and how many distinct marks they carried.
const reads = { count: 0, marks: new Set() };
page.on("request", (request) => {
  if (!/\/streams\/[^/]+\/read$/.test(request.url())) return;
  reads.count += 1;
  reads.marks.add(request.postData() ?? "");
});
const cdp = await context.newCDPSession(page);
await cdp.send("Performance.enable");
if (Number(args.cpu ?? 1) > 1)
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(args.cpu) });

async function memory(gc = true) {
  if (gc) await cdp.send("HeapProfiler.collectGarbage");
  const heap = await cdp.send("Runtime.getHeapUsage");
  const dom = await cdp.send("Memory.getDOMCounters");
  const rows = await page.evaluate(
    () =>
      document.querySelectorAll(
        "[data-testid=chat-scroll] [data-chat-entry-id]"
      ).length
  );
  return {
    heapMB: +(heap.usedSize / 1048576).toFixed(1),
    domNodes: dom.nodes,
    rows,
  };
}

async function metrics() {
  const { metrics: list } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(list.map((m) => [m.name, m.value]));
}

/** Resolves once `test` holds, polled each frame; returns elapsed ms. */
async function until(test, arg, timeout = 30_000) {
  const t0 = Date.now();
  await page.waitForFunction(test, arg, { timeout, polling: "raf" });
  return Date.now() - t0;
}

async function openRoot() {
  const t0 = Date.now();
  await page.goto(`${WEB}/agents/${ROOT}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        "[data-testid=chat-scroll] [data-chat-entry-id]"
      ).length > 3,
    null,
    { timeout: 60_000 }
  );
  const ms = Date.now() - t0;
  await sleep(1500);
  out({ phase: "load", ms, ...(await memory()), markReads: reads.count });
}

async function loadOlder(times) {
  for (let i = 1; i <= times; i += 1) {
    // Rows mounted is not the signal once the feed is windowed; the
    // scroller growing by the page is.
    const before = await page.evaluate(
      () => document.querySelector("[data-testid=chat-scroll]").scrollHeight
    );
    const button = page.locator("[data-testid=chat-scroll] button", {
      hasText: "Load older",
    });
    if ((await button.count()) === 0) break;
    const t0 = Date.now();
    await button.click();
    await page.waitForFunction(
      (h) =>
        document.querySelector("[data-testid=chat-scroll]").scrollHeight >
        h + 2000,
      before,
      { timeout: 60_000 }
    );
    const ms = Date.now() - t0;
    await sleep(800);
    out({ phase: `older-${i}`, ms, ...(await memory()) });
  }
}

async function interactions(tag) {
  const result = { phase: `interact-${tag}` };
  await page.evaluate(() => (window.__events.length = 0));
  // Typing: key-to-paint per keystroke, from Event Timing.
  const input = page.getByTestId("chat-composer-input");
  if (await input.count()) {
    await input.click();
    const t0 = Date.now();
    await page.keyboard.type("checking the stream while it runs", {
      delay: 30,
    });
    result.typeWallMs = Date.now() - t0;
    await sleep(300);
    const keys = await page.evaluate(() =>
      window.__events
        .filter(
          (e) =>
            e.name === "keydown" || e.name === "keypress" || e.name === "input"
        )
        .map((e) => e.duration)
    );
    result.slowKeys = keys.length;
    result.keyP95 = pct(keys, 0.95);
    result.keyMax = keys.length ? Math.round(Math.max(...keys)) : 0;
    await input.fill("");
  }
  // Scrolling: frame gaps while the wheel moves through the feed.
  await page.mouse.move(700, 450);
  await page.evaluate(() => {
    window.__frames = [];
    let last = performance.now();
    const tick = (now) => {
      window.__frames.push(now - last);
      last = now;
      if (window.__frames.length < 600)
        window.__raf = requestAnimationFrame(tick);
    };
    window.__raf = requestAnimationFrame(tick);
  });
  for (let i = 0; i < 25; i += 1) {
    await page.mouse.wheel(0, i < 12 ? -900 : 900);
    await sleep(40);
  }
  const frames = await page.evaluate(() => {
    cancelAnimationFrame(window.__raf);
    return window.__frames;
  });
  result.scrollFrameP95 = pct(frames, 0.95);
  result.scrollFramesOver50 = frames.filter((f) => f > 50).length;
  // Expanding a turn's steps.
  const fold = page
    .locator("[data-testid=chat-scroll] [data-testid=harness-activity-fold]")
    .last();
  if (await fold.count()) {
    await fold.scrollIntoViewIfNeeded();
    const before = await page.locator("[data-testid=harness-step]").count();
    const t0 = Date.now();
    await fold.click();
    await page
      .waitForFunction(
        (n) =>
          document.querySelectorAll("[data-testid=harness-step]").length !== n,
        before,
        { timeout: 10_000 }
      )
      .catch(() => {});
    result.expandStepsMs = Date.now() - t0;
    await fold.click();
  }
  // Opening the long finding discussion, as its link in the review does.
  const finding = setup.findings?.[0];
  if (finding) {
    const t0 = Date.now();
    await page.evaluate((id) => {
      const url = new URL(location.href);
      url.searchParams.set("thread", id);
      history.pushState({}, "", url);
      dispatchEvent(new PopStateEvent("popstate"));
    }, finding);
    await page
      .waitForFunction(
        () =>
          document.querySelectorAll(
            "[data-testid=chat-thread-scroll] [data-chat-entry-id]"
          ).length > 10,
        null,
        { timeout: 20_000 }
      )
      .catch(() => {});
    result.openThreadMs = Date.now() - t0;
    result.threadRows = await page.evaluate(
      () =>
        document.querySelectorAll(
          "[data-testid=chat-thread-scroll] [data-chat-entry-id]"
        ).length
    );
    await sleep(500);
    await page.evaluate(() => {
      const url = new URL(location.href);
      url.searchParams.delete("thread");
      history.pushState({}, "", url);
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await sleep(800);
  }
  // Switching to a child agent and back.
  const child = setup.builders?.[0];
  if (child) {
    let t0 = Date.now();
    await page.evaluate((id) => {
      history.pushState({}, "", `/agents/${id}`);
      dispatchEvent(new PopStateEvent("popstate"));
    }, child);
    await page.waitForFunction(
      (id) =>
        location.pathname.includes(id) &&
        document.querySelector("[data-testid=chat-scroll]"),
      child,
      { timeout: 20_000 }
    );
    result.switchAwayMs = Date.now() - t0;
    await sleep(500);
    t0 = Date.now();
    await page.evaluate((id) => {
      history.pushState({}, "", `/agents/${id}`);
      dispatchEvent(new PopStateEvent("popstate"));
    }, ROOT);
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          "[data-testid=chat-scroll] [data-chat-entry-id]"
        ).length > 3,
      null,
      { timeout: 30_000 }
    );
    result.switchBackMs = Date.now() - t0;
  }
  const slow = await page.evaluate(() =>
    window.__events.map((e) => e.duration)
  );
  result.slowEventsOver100 = slow.filter((d) => d > 100).length;
  result.worstEventMs = slow.length ? Math.round(Math.max(...slow)) : 0;
  out(result);
}

async function liveWindow(seconds) {
  const driver = spawn(
    process.execPath,
    [
      path.join(here, "drive.mjs"),
      "live",
      "--api",
      args.api,
      "--root",
      ROOT,
      "--finding",
      setup.findings[0],
      "--seconds",
      String(seconds),
    ],
    { stdio: "ignore" }
  );
  const driverDone = new Promise((resolve) => driver.on("exit", resolve));
  const step = 15;
  let prev = await metrics();
  let prevSse = await page.evaluate(() => ({ ...window.__sse }));
  let prevLong = await page.evaluate(() => ({ ...window.__long }));
  let prevReads = reads.count;
  for (let t = step; t <= seconds; t += step) {
    await sleep(step * 1000);
    const now = await metrics();
    const sse = await page.evaluate(() => ({ ...window.__sse }));
    const long = await page.evaluate(() => ({ ...window.__long }));
    const busy = (k) => +(((now[k] - prev[k]) / step) * 100).toFixed(1);
    out({
      phase: `live+${t}s`,
      ...(await memory(false)),
      taskPct: busy("TaskDuration"),
      scriptPct: busy("ScriptDuration"),
      layoutPct: busy("LayoutDuration"),
      stylePct: busy("RecalcStyleDuration"),
      longTasks: long.count - prevLong.count,
      longTaskMs: Math.round(long.total - prevLong.total),
      ssePerSec: +((sse.events - prevSse.events) / step).toFixed(1),
      sseKBPerSec: Math.round((sse.bytes - prevSse.bytes) / step / 1024),
      entryKBPerSec: Math.round(
        (sse.entryBytes - prevSse.entryBytes) / step / 1024
      ),
      markReads: reads.count - prevReads,
      distinctMarks: reads.marks.size,
    });
    prevReads = reads.count;
    prev = now;
    prevSse = sse;
    prevLong = long;
    if (t === step * 2) await interactions("during-live");
  }
  await driverDone;
  out({ phase: "live-done", ...(await memory()) });
}

await openRoot();
await interactions("idle");
await loadOlder(Number(args.older ?? 3));
await interactions("after-older");
if (Number(args.live ?? 0) > 0) await liveWindow(Number(args.live));
// Leaving the long stream, as switching away or archiving it would.
await page.evaluate((id) => {
  history.pushState({}, "", `/agents/${id}`);
  dispatchEvent(new PopStateEvent("popstate"));
}, setup.reviewers?.[0] ?? ROOT);
await sleep(4000);
out({ phase: "navigated-away", ...(await memory()) });
await browser.close();
