import { describe, expect, it } from "vitest";

import {
  createStaticThemeRuntime,
  VALID_ICON_COLORS,
} from "../src/server/static-theme.js";

function fakeAsset(routePath: string, content: string) {
  return {
    routePath,
    contentType: "text/html",
    base64: Buffer.from(content).toString("base64"),
  };
}

describe("createStaticThemeRuntime", () => {
  it("defaults to teal icon color", () => {
    const runtime = createStaticThemeRuntime([]);
    expect(runtime.getCachedIconColor()).toBe("teal");
  });

  it("returns unmodified HTML when color is teal", () => {
    const html = '<link rel="icon" href="/icons/teal/favicon.svg">';
    const runtime = createStaticThemeRuntime([fakeAsset("/index.html", html)]);
    expect(runtime.getCachedIndexHtml()).toBe(html);
  });

  it("rewrites icon paths for non-teal colors", () => {
    const html = '<link rel="icon" href="/icons/teal/favicon.svg">';
    const runtime = createStaticThemeRuntime([fakeAsset("/index.html", html)]);
    runtime.rewriteForColor("purple");
    expect(runtime.getCachedIconColor()).toBe("purple");
    expect(runtime.getCachedIndexHtml()).toBe(
      '<link rel="icon" href="/icons/purple/favicon.svg">'
    );
  });

  it("rewrites manifest icon paths", () => {
    const manifest = '{"icons":[{"src":"/icons/teal/icon-192.png"}]}';
    const runtime = createStaticThemeRuntime([
      fakeAsset("/manifest.webmanifest", manifest),
    ]);
    runtime.rewriteForColor("blue");
    expect(runtime.getCachedManifest()).toContain("/icons/blue/icon-192.png");
  });

  it("reverts to original templates when switching back to teal", () => {
    const html = '<link href="/icons/teal/icon.svg">';
    const runtime = createStaticThemeRuntime([fakeAsset("/index.html", html)]);
    runtime.rewriteForColor("red");
    expect(runtime.getCachedIndexHtml()).toContain("/icons/red/");
    runtime.rewriteForColor("teal");
    expect(runtime.getCachedIndexHtml()).toBe(html);
  });

  it("replaces all teal references in a single rewrite", () => {
    const html =
      '<link href="/icons/teal/a.svg"><link href="/icons/teal/b.png">';
    const runtime = createStaticThemeRuntime([fakeAsset("/index.html", html)]);
    runtime.rewriteForColor("orange");
    expect(runtime.getCachedIndexHtml()).not.toContain("/icons/teal/");
    expect(runtime.getCachedIndexHtml()).toContain("/icons/orange/a.svg");
    expect(runtime.getCachedIndexHtml()).toContain("/icons/orange/b.png");
  });

  it("stores decoded static assets in the map", () => {
    const runtime = createStaticThemeRuntime([
      fakeAsset("/index.html", "<html>"),
      fakeAsset("/manifest.webmanifest", "{}"),
    ]);
    expect(runtime.staticAssets.size).toBe(2);
    expect(runtime.staticAssets.get("/index.html")?.body.toString()).toBe(
      "<html>"
    );
  });

  it("VALID_ICON_COLORS contains the expected palette", () => {
    expect(VALID_ICON_COLORS).toContain("teal");
    expect(VALID_ICON_COLORS).toContain("blue");
    expect(VALID_ICON_COLORS).toContain("purple");
    expect(VALID_ICON_COLORS.length).toBeGreaterThanOrEqual(8);
  });
});
