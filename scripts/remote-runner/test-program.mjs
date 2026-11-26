// Exercise both entry points with an empty home and no enrolled service.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../../packages/runner/src/standalone.ts", import.meta.url));
const bun = process.env.BUN_BINARY ?? spawnSync("which", ["bun"], { encoding: "utf8" }).stdout.trim();
const binary = path.resolve(process.argv[2]);
const dir = mkdtempSync(path.join(tmpdir(), "dispatch-program-"));
try {
  const shell = path.join(dir, "shell");
  writeFileSync(shell, "#!/bin/sh\nsleep 0.2\n", { mode: 0o700 });
  const env = { HOME: dir, PATH: "/usr/bin:/bin", SHELL: shell, TMPDIR: dir };
  writeFileSync(path.join(dir, "fixture.txt"), "worker fixture\n");
  writeFileSync(path.join(dir, "runner.json"), JSON.stringify({endpoint:"http://invalid.example"}));
  assert.equal(spawnSync("git", ["init", "-q",dir]).status, 0);
  const fixtures = [
    [["agent-host"], "", /usage: dispatch agent-host --state/],
    [["claude-acp","--version"], "", /0\.108\.0/],
    [["codex-acp","--version"], "", /2\.7\.0/],
    [["local-runner"], "{}", /first launcher message|invalid|start/i],
    [["remote-runner",path.join(dir,"runner.json")], "", /Runner requires an HTTPS endpoint/],
    [["remote-runner-pair"], "", /Usage:/],
    [["connect"], "", /Usage:/],
    [["runner-worker","git-context",dir], "", /\{/],
    [["runner-view-checkout",dir], "{}", /Unable to read the session checkout/],
    [["runner-inspect-checkout",dir], '{"kind":"roots"}', /"kind":"roots"/],
    [["runner-observe-checkout",dir,"--scratch"], "", /"stateId"/],
    [["runner-watch-checkout",dir], "", /^(1\n)*$/],
    [["runner-prepare-dependencies",dir], "", /^$/],
    [["runner-session-file","stream",dir,"fixture.txt"], "", /worker fixture/],
    [["runner-checkout-command",dir,"fixture"], "{}", /Invalid checkout command/],
    [["runner-engine-capability"], "{}", /Engine capability is unavailable/],
    [["runner-engine-host"], "", /^$/],
    [["runner-update-compatibility"], "", /"handoff"/],
    [["runner-update-trial"], "", /requires the managed Linux installation/],
    [["runner-update-stage"], "", /Usage: dispatch runner-update-stage/],
    [["runner-terminal",dir], "", /"ready"/],
    [["runner-terminal",dir,"80","24"], "", /"cwd"/],
  ];
  const assetFixture = fileURLToPath(new URL("../../packages/runner/test/fixtures/program-assets.ts", import.meta.url));
  const helper = readFileSync(new URL("../../bin/dispatch-stream", import.meta.url));
  const assetBinary = path.join(dir, "assets");
  assert.equal(spawnSync(bun, ["build", "--compile", assetFixture, "--outfile", assetBinary]).status, 0);
  for (const [command, args] of [[bun, [assetFixture]], [assetBinary, []]]) {
    const result = spawnSync(command, args, {cwd:dir,env});
    assert.equal(result.status, 0);
    assert.deepEqual(result.stdout, helper);
  }
  for (const [args,input,pattern] of fixtures) {
    let expectedStatus;
    for (const command of [[bun,entry],[binary]]) {
      const result = spawnSync(command[0], [...command.slice(1),...args], {
        cwd: dir, env, input: input ? input+"\n" : "", encoding:"utf8",timeout: 5000,
        stdio: ["pipe","pipe","pipe","pipe"],
      });
      if (result.error) throw result.error;
      const output = result.output.slice(1).join("");
      assert.match(output,pattern,args.join(" ")+" "+output.slice(-600));
      assert.equal(result.signal,null);
      expectedStatus ??= result.status;
      assert.equal(result.status,expectedStatus,args.join(" "));
    }
    console.log(args[0], "passed");
  }
} finally {
  rmSync(dir,{recursive:true,force:true});
}
