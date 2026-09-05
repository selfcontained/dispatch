import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listDshSkills, parseSkillFile } from "../src/agents/dsh/skills.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "dsh-skills-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function skill(dir: string, folder: string, text: string) {
  await mkdir(path.join(dir, folder), { recursive: true });
  await writeFile(path.join(dir, folder, "SKILL.md"), text);
}

describe("parseSkillFile", () => {
  it("reads name and description from front matter", () => {
    expect(
      parseSkillFile(
        "folder",
        '---\nname: brain\ndescription: "Shared memory tools"\n---\n# Brain\n'
      )
    ).toEqual({ name: "brain", description: "Shared memory tools" });
  });

  it("falls back to the folder and first paragraph", () => {
    expect(
      parseSkillFile("review", "# Review\n\nHow to review a diff.\n\nMore.")
    ).toEqual({ name: "review", description: "How to review a diff." });
  });
});

describe("listDshSkills", () => {
  it("lists project and home skills, project first on a clash", async () => {
    const cwd = path.join(root, "repo");
    const home = path.join(root, "home");
    await skill(
      path.join(cwd, ".agents", "skills"),
      "brain",
      "---\nname: brain\ndescription: project brain\n---\n"
    );
    await skill(
      path.join(cwd, ".dsh", "skills"),
      "jobs",
      "---\nname: jobs\ndescription: schedule jobs\n---\n"
    );
    await skill(
      path.join(home, "skills"),
      "brain",
      "---\nname: brain\ndescription: home brain\n---\n"
    );
    await skill(path.join(home, "skills"), "zeta", "Last one.");
    await mkdir(path.join(home, "skills", "not-a-skill"), { recursive: true });

    const skills = await listDshSkills({ cwd, dshHome: home });
    expect(skills).toEqual([
      { name: "brain", description: "project brain", source: "project" },
      { name: "jobs", description: "schedule jobs", source: "project" },
      { name: "zeta", description: "Last one.", source: "home" },
    ]);
  });

  it("is empty when no directory exists", async () => {
    expect(
      await listDshSkills({
        cwd: path.join(root, "nope"),
        dshHome: path.join(root, "nope2"),
      })
    ).toEqual([]);
  });
});
