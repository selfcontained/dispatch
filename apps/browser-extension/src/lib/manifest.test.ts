import { describe, expect, it } from "vitest";

import packageJson from "../../package.json";
import manifest from "../../public/manifest.json";

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
