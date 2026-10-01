import { test, expect } from "@playwright/test";
import http from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";

test("in-app trust links reach the server with a controlling production service worker", async ({
  browser,
  baseURL,
}) => {
  // The normal E2E server serves the production bundle. This isolated proxy
  // supplies the managed-Mac capability and trust responses without changing
  // the standalone server's TLS configuration or any device trust store.
  const hits: string[] = [];
  const profile =
    '<?xml version="1.0"?><plist><dict><key>PayloadType</key><string>com.apple.security.root</string></dict></plist>';
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url!, "http://localhost").pathname;
    if (pathname === "/api/v1/system/certificate-trust") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ available: true }));
    } else if (pathname === "/trust") {
      hits.push(pathname);
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><h1>Trust this Dispatch server</h1>");
    } else if (pathname === "/trust/dispatch.mobileconfig") {
      hits.push(pathname);
      response.setHeader("Content-Type", "application/x-apple-aspen-config");
      response.setHeader(
        "Content-Disposition",
        "attachment; filename=dispatch.mobileconfig"
      );
      response.end(profile);
    } else {
      const target = new URL(request.url!, baseURL);
      const transport = target.protocol === "https:" ? https : http;
      const upstream = transport.request(
        target,
        {
          method: request.method,
          headers: { ...request.headers, host: target.host },
        },
        (result) => {
          response.writeHead(result.statusCode!, result.headers);
          result.pipe(response);
        }
      );
      upstream.on("error", () => {
        response.writeHead(502);
        response.end();
      });
      response.on("close", () => upstream.destroy());
      request.pipe(upstream);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const context = await browser.newContext({
    baseURL: origin,
    viewport: { width: 390, height: 844 },
    serviceWorkers: "allow",
  });
  try {
    const page = await context.newPage();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("main")).toBeVisible();
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() =>
      navigator.serviceWorker.controller?.scriptURL.endsWith("/sw.js")
    );
    const openSidebar = page.getByTitle("Open sidebar");
    if (await openSidebar.isVisible()) await openSidebar.click();
    await page.getByTestId("settings-button").click();
    await page
      .getByTestId("sidebar-shell")
      .getByRole("button", { name: "Security", exact: true })
      .click();
    const setup = page.getByRole("link", {
      name: "Set up certificate trust",
      exact: true,
    });
    await expect(setup).toBeVisible();
    const downloading = page.waitForEvent("download");
    await page
      .getByRole("link", { name: "Download Apple trust profile", exact: true })
      .click();
    const download = await downloading;
    expect(await readFile((await download.path())!, "utf8")).toBe(profile);
    expect(hits).toContain("/trust/dispatch.mobileconfig");
    await setup.click();
    await expect(
      page.getByRole("heading", {
        name: "Trust this Dispatch server",
        exact: true,
      })
    ).toBeVisible();
    expect(hits).toContain("/trust");
    await page.goBack({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("link", { name: "Set up certificate trust", exact: true })
    ).toBeVisible();
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
