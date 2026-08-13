import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

/**
 * Guards the published Dispatch plugin (Claude Code + Codex) that lives at the
 * repo root. CI has no `claude`/`codex` CLI to run `claude plugin validate`
 * against, and every failure mode here is silent at install time: a SKILL.md
 * whose YAML frontmatter fails to parse still installs, it just loads with
 * empty metadata and the skill never fires.
 */
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);
const PLUGIN_NAME = "dispatch";
const MARKETPLACE_NAME = "dispatch";
const PLUGIN_DIR = path.join(repoRoot, "plugins", PLUGIN_NAME);
const SKILLS_DIR = path.join(PLUGIN_DIR, "skills");

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

const skillSlugs = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe("plugin manifests", () => {
  it("declares the same plugin under both marketplace formats", () => {
    const claude = readJson(".claude-plugin/marketplace.json");
    const codex = readJson(".agents/plugins/marketplace.json");

    // The install identifier is `<plugin>@<marketplace>`. If the two
    // marketplace names drift, the documented command works on one platform
    // and fails on the other.
    expect(claude.name).toBe(MARKETPLACE_NAME);
    expect(codex.name).toBe(MARKETPLACE_NAME);

    const claudePlugins = claude.plugins as Array<Record<string, unknown>>;
    const codexPlugins = codex.plugins as Array<Record<string, unknown>>;
    expect(claudePlugins.map((p) => p.name)).toEqual([PLUGIN_NAME]);
    expect(codexPlugins.map((p) => p.name)).toEqual([PLUGIN_NAME]);

    // Claude takes a bare relative string, Codex takes a local-source object.
    expect(claudePlugins[0].source).toBe(`./plugins/${PLUGIN_NAME}`);
    expect(codexPlugins[0].source).toEqual({
      source: "local",
      path: `./plugins/${PLUGIN_NAME}`,
    });
  });

  it("keeps both plugin manifests on the same name and version", () => {
    const claude = readJson(
      `plugins/${PLUGIN_NAME}/.claude-plugin/plugin.json`
    );
    const codex = readJson(`plugins/${PLUGIN_NAME}/.codex-plugin/plugin.json`);

    expect(claude.name).toBe(PLUGIN_NAME);
    expect(codex.name).toBe(PLUGIN_NAME);

    // Claude resolves the plugin version from plugin.json and uses it as the
    // update cache key; Codex requires it outright. A mismatch means the two
    // platforms disagree about which version is installed.
    expect(claude.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(codex.version).toBe(claude.version);

    // Codex requires a description; Claude only warns without one.
    expect(typeof codex.description).toBe("string");
    expect((codex.description as string).length).toBeGreaterThan(0);
  });
});

describe("plugin skills", () => {
  it("ships at least one skill", () => {
    expect(skillSlugs.length).toBeGreaterThan(0);
  });

  it.each(skillSlugs)("%s has parseable frontmatter", (slug) => {
    const source = readFileSync(
      path.join(SKILLS_DIR, slug, "SKILL.md"),
      "utf8"
    );

    const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
    expect(match, "SKILL.md must open with a YAML frontmatter block").not.toBe(
      null
    );

    // An unquoted `: ` or a leading `[`/`{`/`*`/`&` in a description is the
    // realistic failure here — it parses as YAML structure, the block fails,
    // and the skill silently loads with no name or description at all.
    const frontmatter = parseYaml(match![1]) as Record<string, unknown>;

    expect(frontmatter.name).toBe(slug);
    expect(typeof frontmatter.description).toBe("string");
    expect((frontmatter.description as string).trim().length).toBeGreaterThan(
      0
    );
  });

  it("keeps the always-on description budget in check", () => {
    // Skill names and descriptions are injected into every session whether or
    // not any skill fires, so this total is the plugin's unconditional cost.
    // The ceiling is the 2,891 chars Dispatch's own launch guidance already
    // injects — the plugin should not cost more than the guidance it augments.
    const total = skillSlugs.reduce((sum, slug) => {
      const source = readFileSync(
        path.join(SKILLS_DIR, slug, "SKILL.md"),
        "utf8"
      );
      const frontmatter = parseYaml(
        /^---\n([\s\S]*?)\n---\n/.exec(source)![1]
      ) as Record<string, unknown>;
      return sum + slug.length + (frontmatter.description as string).length;
    }, 0);

    expect(total).toBeLessThan(2891);
  });
});
