import { execFileSync } from "node:child_process";
import {
  existsSync,
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
    expect(
      (
        await runner.session.call("workspace.observe", {
          session: owner,
          policy: "ownership",
        })
      ).borrowers
    ).toContain("borrower");
    mkdirSync(join(state, ".launches"), { recursive: true });
    writeFileSync(
      join(state, ".launches", "owner.json"),
      JSON.stringify({ launchId: "stopped-launch", stage: "spawning" })
    );
    writeFileSync(join(state, "owner", "host.log"), "stopped host log");
    await runner.session.call("session.retire", {
      session: owner,
      checkoutPending: true,
    });
    expect(existsSync(join(state, ".launches", "owner.json"))).toBe(false);
    expect(existsSync(join(state, "owner", "host.log"))).toBe(false);
    expect(existsSync(join(state, "owner", "workspace-preparation"))).toBe(
      true
    );
    expect(await bindings.get("owner")).not.toBeNull();
    expect(
      (
        await runner.session.call("workspace.observe", {
          session: owner,
          policy: "ownership",
        })
      ).borrowers
    ).toContain("borrower");
    await runner.session.call("session.retire", {
      session: child,
    });
    expect(await bindings.get("borrower")).toBeNull();
    expect(
      (
        await runner.session.call("workspace.observe", {
          session: owner,
          policy: "ownership",
        })
      ).borrowers
    ).not.toContain("borrower");
    await runner.session.call("session.retire", {
      session: owner,
    });
    expect(await bindings.get("owner")).toBeNull();
    expect(readFileSync(join(String(owned.path), "dirty"), "utf8")).toBe(
      "retained through restart"
    );
    await runner.session.call("session.retire", {
      session: owner,
    });
    const releaseOwner = sessionFromWire("release-owner"),
      releaseChild = sessionFromWire("release-child");
    const releasing = await runner.session.call("workspace.prepare", {
      session: releaseOwner,
      source: {
        repository: origin,
        checkout: { kind: "new", branch: "release-after-retirement" },
      },
      copyIgnored: [],
      installDependencies: false,
    });
    await runner.session.call("workspace.prepare", {
      session: releaseChild,
      source: { session: releaseOwner },
      copyIgnored: [],
      installDependencies: false,
    });
    expect(
      await runner.session.call("workspace.release", {
        session: releaseOwner,
        deleteBranch: true,
        originalBranch: "release-after-retirement",
      })
    ).toEqual({ removed: false });
    await runner.session.call("session.retire", {
      session: releaseOwner,
      checkoutPending: true,
    });
    const beforeRetry = runner.pids.length;
    process.kill(runner.current()!.pid, "SIGKILL");
    await runner.ready(beforeRetry);
    expect(
      (
        await runner.session.call("workspace.observe", {
          session: releaseOwner,
          policy: "ownership",
        })
      ).borrowers
    ).toContain("release-child");
    await runner.session.call("session.retire", { session: releaseChild });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        await runner.session.call("workspace.release", {
          session: releaseOwner,
          deleteBranch: true,
          originalBranch: "release-after-retirement",
        })
      ).toEqual({ removed: true });
      await runner.session.call("session.retire", { session: releaseOwner });
    }
    expect(existsSync(String(releasing.path))).toBe(false);
    expect(existsSync(join(state, String(releaseOwner)))).toBe(false);
    expect(await bindings.get(String(releaseOwner))).toBeNull();
  } finally {
    await runner.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
