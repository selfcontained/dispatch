import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { HarnessSkill } from "@dispatch/shared";

/**
 * Where dsh's skill loader (dsh-skill-filesystem) looks for <name>/SKILL.md:
 * two project directories under the working tree, then the harness home.
 * The Harness composer's slash menu lists the same set the agent can load.
 */
export function dshSkillDirs(input: {
  cwd: string;
  dshHome: string;
}): { dir: string; source: HarnessSkill["source"] }[] {
  return [
    { dir: path.join(input.cwd, ".agents", "skills"), source: "project" },
    { dir: path.join(input.cwd, ".dsh", "skills"), source: "project" },
    { dir: path.join(input.dshHome, "skills"), source: "home" },
  ];
}

/** name/description from SKILL.md front matter; the folder name otherwise. */
export function parseSkillFile(
  folder: string,
  text: string
): { name: string; description: string } {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  let name = folder;
  let description = "";
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
      if (!m) continue;
      const value = m[2].trim().replace(/^["']|["']$/g, "");
      if (m[1] === "name" && value) name = value;
      if (m[1] === "description") description = value;
    }
  }
  if (!description) {
    const body = fm ? text.slice(fm[0].length) : text;
    const para = body
      .split(/\r?\n\s*\r?\n/)
      .map((p) => p.replace(/^#.*$/gm, "").replace(/\s+/g, " ").trim())
      .find((p) => p.length > 0);
    description = para ? para.slice(0, 160) : "";
  }
  return { name, description };
}

/** Skills the agent can load, first directory wins on a name clash. */
export async function listDshSkills(input: {
  cwd: string;
  dshHome: string;
}): Promise<HarnessSkill[]> {
  const seen = new Map<string, HarnessSkill>();
  for (const { dir, source } of dshSkillDirs(input)) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const folder of entries.sort()) {
      const file = path.join(dir, folder, "SKILL.md");
      try {
        if (!(await stat(file)).isFile()) continue;
        const text = await readFile(file, "utf8");
        const parsed = parseSkillFile(folder, text);
        if (!seen.has(parsed.name)) {
          seen.set(parsed.name, { ...parsed, source });
        }
      } catch {
        continue;
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
