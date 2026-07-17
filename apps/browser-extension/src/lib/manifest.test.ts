import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import packageJson from "../../package.json";
import manifest from "../../public/manifest.json";
import safariManifest from "../../manifest.safari.json";

describe("extension manifest", () => {
  it("stays synchronized with the extension package version", () => {
    expect(manifest.version).toBe(packageJson.version);
  });

  it("declares the files and least-privilege runtime capabilities it uses", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background.service_worker).toBe("service-worker.js");
    expect(manifest.side_panel.default_path).toBe("side-panel.html");
    expect(manifest.permissions).toEqual(["scripting", "storage", "sidePanel"]);
    expect(manifest.optional_host_permissions).toEqual([
      "http://*/*",
      "https://*/*",
    ]);
  });
});

describe("safari extension manifest", () => {
  it("stays synchronized with the extension package version", () => {
    expect(safariManifest.version).toBe(packageJson.version);
  });

  it("declares the Safari-appropriate capabilities", () => {
    expect(safariManifest.manifest_version).toBe(3);
    expect(safariManifest.background.service_worker).toBe("background.js");
    expect(safariManifest.action.default_popup).toBe("popup.html");
    // Safari mediates host access per site itself; activeTab covers
    // popup-invoked injection and there is no side panel on Safari.
    expect(safariManifest.permissions).toEqual([
      "scripting",
      "storage",
      "activeTab",
    ]);
    expect(safariManifest.host_permissions).toEqual([
      "http://*/*",
      "https://*/*",
    ]);
    expect(safariManifest).not.toHaveProperty("side_panel");
    expect(safariManifest).not.toHaveProperty("optional_host_permissions");
  });

  it("keeps the Xcode project marketing version synchronized", () => {
    const pbxproj = readFileSync(
      resolve(
        import.meta.dirname,
        "../../safari/Dispatch Feedback/Dispatch Feedback.xcodeproj/project.pbxproj"
      ),
      "utf8"
    );
    const versions = [...pbxproj.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map(
      (match) => match[1]
    );
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      expect(version).toBe(packageJson.version);
    }
  });
});
