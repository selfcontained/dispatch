import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectRepoIcon } from "../src/shared/repo-icon.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "repo-icon-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function touch(relPath: string): Promise<void> {
  const full = path.join(tmpDir, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, "");
}

describe("detectRepoIcon", () => {
  it("returns null for an empty directory", async () => {
    expect(await detectRepoIcon(tmpDir)).toBeNull();
  });

  it("returns null when no icon-like files exist", async () => {
    await touch("README.md");
    await touch("src/index.ts");
    expect(await detectRepoIcon(tmpDir)).toBeNull();
  });

  it("finds a root-level favicon.svg", async () => {
    await touch("favicon.svg");
    expect(await detectRepoIcon(tmpDir)).toBe("favicon.svg");
  });

  it("finds a favicon.png in a subdirectory", async () => {
    await touch("public/favicon.png");
    expect(await detectRepoIcon(tmpDir)).toBe(
      path.join("public", "favicon.png")
    );
  });

  it("prefers svg over png", async () => {
    await touch("icon.svg");
    await touch("icon.png");
    expect(await detectRepoIcon(tmpDir)).toBe("icon.svg");
  });

  it("prefers png over ico", async () => {
    await touch("favicon.png");
    await touch("favicon.ico");
    expect(await detectRepoIcon(tmpDir)).toBe("favicon.png");
  });

  it("prefers favicon over logo", async () => {
    await touch("logo.svg");
    await touch("favicon.svg");
    expect(await detectRepoIcon(tmpDir)).toBe("favicon.svg");
  });

  it("prefers shallower files over deeper ones", async () => {
    await touch("favicon.svg");
    await touch("assets/deep/favicon.svg");
    expect(await detectRepoIcon(tmpDir)).toBe("favicon.svg");
  });

  it("finds logo files", async () => {
    await touch("assets/logo.png");
    expect(await detectRepoIcon(tmpDir)).toBe(path.join("assets", "logo.png"));
  });

  it("finds brand-icon files", async () => {
    await touch("brand-icon.svg");
    expect(await detectRepoIcon(tmpDir)).toBe("brand-icon.svg");
  });

  it("is case-insensitive for icon names", async () => {
    await touch("FAVICON.SVG");
    expect(await detectRepoIcon(tmpDir)).toBe("FAVICON.SVG");
  });

  it("skips node_modules", async () => {
    await touch("node_modules/pkg/favicon.svg");
    expect(await detectRepoIcon(tmpDir)).toBeNull();
  });

  it("skips dotfiles and dot directories", async () => {
    await touch(".hidden/favicon.svg");
    expect(await detectRepoIcon(tmpDir)).toBeNull();
  });

  it("skips dist and build directories", async () => {
    await touch("dist/favicon.svg");
    await touch("build/logo.png");
    expect(await detectRepoIcon(tmpDir)).toBeNull();
  });

  it("does not match non-icon image files", async () => {
    await touch("screenshot.png");
    await touch("photo.svg");
    expect(await detectRepoIcon(tmpDir)).toBeNull();
  });

  it("returns null for a missing directory", async () => {
    expect(await detectRepoIcon(path.join(tmpDir, "nonexistent"))).toBeNull();
  });

  it("handles icon pattern in the middle of a name", async () => {
    await touch("my-icon-file.svg");
    expect(await detectRepoIcon(tmpDir)).toBe("my-icon-file.svg");
  });

  it("handles logo pattern in the middle of a name", async () => {
    await touch("project-logo-dark.png");
    expect(await detectRepoIcon(tmpDir)).toBe("project-logo-dark.png");
  });

  it("ignores icons deeper than MAX_SCAN_DEPTH (4)", async () => {
    await touch("a/b/c/d/e/favicon.svg");
    expect(await detectRepoIcon(tmpDir)).toBeNull();
  });

  it("finds icons at exactly MAX_SCAN_DEPTH", async () => {
    await touch("a/b/c/d/favicon.svg");
    expect(await detectRepoIcon(tmpDir)).toBe(
      path.join("a", "b", "c", "d", "favicon.svg")
    );
  });

  describe("conventional .dispatch/logo file", () => {
    it("finds .dispatch/logo.png despite the dot-directory skip that applies to the generic scan", async () => {
      await touch(".dispatch/logo.png");
      expect(await detectRepoIcon(tmpDir)).toBe(
        path.join(".dispatch", "logo.png")
      );
    });

    it("takes priority over a root-level favicon", async () => {
      await touch("favicon.svg");
      await touch(".dispatch/logo.png");
      expect(await detectRepoIcon(tmpDir)).toBe(
        path.join(".dispatch", "logo.png")
      );
    });

    it("prefers svg over png over ico within .dispatch", async () => {
      await touch(".dispatch/logo.ico");
      await touch(".dispatch/logo.png");
      await touch(".dispatch/logo.svg");
      expect(await detectRepoIcon(tmpDir)).toBe(
        path.join(".dispatch", "logo.svg")
      );
    });

    it("prefers png over ico within .dispatch when no svg exists", async () => {
      await touch(".dispatch/logo.ico");
      await touch(".dispatch/logo.png");
      expect(await detectRepoIcon(tmpDir)).toBe(
        path.join(".dispatch", "logo.png")
      );
    });

    it("ignores unrelated files under .dispatch and falls back to the generic scan", async () => {
      await touch(".dispatch/config.json");
      await touch("favicon.svg");
      expect(await detectRepoIcon(tmpDir)).toBe("favicon.svg");
    });
  });
});
