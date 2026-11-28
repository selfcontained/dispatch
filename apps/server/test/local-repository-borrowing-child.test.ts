import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sessionFromWire } from "@dispatch/runner-protocol/contract";
import { BindingStore } from "../../../packages/runner/src/local/bindings.js";
import { startTestLocalRunner } from "./helpers/local-runner-child.js";

it("adopts a repository borrow after the Local child restarts without turning the borrower into an owner", async () => {
  const root = realpathSync(mkdtempSync("/tmp/rb-"));
  const repo = join(root, "repo"),
    origin = join(root, "origin.git"),
    state = join(root, "s"),
    home = join(root, "home");
  mkdirSync(repo);
  mkdirSync(home);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q", "-b", "main", repo);
  git(
    "-C",
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "base"
  );
  git("clone", "--bare", "-q", repo, origin);
  const runner = startTestLocalRunner(state, {
    env: {
      HOME: home,
      GH_CONFIG_DIR: join(home, "gh"),
      XDG_CONFIG_HOME: join(home, "config"),
    },
  });
  const owner = sessionFromWire("owner"),
    child = sessionFromWire("borrower");
  try {
    await runner.ready();
    const owned = await runner.session.call("workspace.prepare", {
      session: owner,
      source: {
        repository: origin,
        checkout: { kind: "new", branch: "feature", base: "main" },
      },
      copyIgnored: [],
      installDependencies: false,
    });
    const request = {
      session: child,
      source: { session: owner },
      copyIgnored: [],
      installDependencies: false,
    };
    expect(
      await runner.session.call("workspace.prepare", request)
    ).toMatchObject({ path: owned.path, worktree: null });
    const bindings = new BindingStore(state);
    const before = await bindings.get("owner");
    expect(await bindings.get("borrower")).toMatchObject({
      source: "prepare",
      borrowedFrom: "owner",
      checkout: { ownership: "external" },
    });
    writeFileSync(
      join(String(owned.path), "dirty"),
      "retained through restart"
    );
    const count = runner.pids.length;
    process.kill(runner.current()!.pid, "SIGKILL");
    await runner.ready(count);
    expect(
      await runner.session.call("workspace.prepare", request)
    ).toMatchObject({ path: owned.path, worktree: null });
    expect(
      await runner.session.call("workspace.observe", {
        session: child,
        policy: "ownership",
      })
    ).toMatchObject({ ownership: "borrowed", owner: "owner", checkout: null });
    expect(
      (await new BindingStore(state).get("owner"))!.checkout.identity
    ).toBe(before!.checkout.identity);
    expect(readFileSync(join(String(owned.path), "dirty"), "utf8")).toBe(
      "retained through restart"
    );
  } finally {
    await runner.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
