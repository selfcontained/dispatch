import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  chmodSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import YAML from "yaml";

const workflow = YAML.parse(
  readFileSync(".github/workflows/release.yml", "utf8")
);
const step = (job, name) =>
  workflow.jobs[job].steps.find((s) => s.name === name);

test("Mac jobs require the existing native ARM64 runner and verify tools before secrets", () => {
  for (const job of ["build-binaries", "build-macos-app"]) {
    assert.deepEqual(workflow.jobs[job]["runs-on"], [
      "self-hosted",
      "macOS",
      "ARM64",
    ]);
    assert.match(step(job, "Verify native macOS toolchain").run, /uname -m/);
  }
});

test("recovery does not enter bump branch and validates immutable tag before building", () => {
  const prepare = step("prepare-release", "Prepare release commit");
  assert.match(prepare.run, /workflow_dispatch.*&&.*-z "\$RECOVERY_TAG"/);
  assert.match(
    prepare.run,
    /checkout --detach "refs\/tags\/\$TAG\^\{commit\}"/
  );
  assert.match(prepare.run, /merge-base --is-ancestor HEAD origin\/main/);
  assert.match(prepare.run, /PACKAGE_VERSION.*!=.*TAG/);
  assert.match(prepare.run, /release \$TAG already exists/);
  assert.equal(prepare.env.RECOVERY_TAG, "${{ inputs.recovery_tag }}");
  assert.match(
    prepare.run,
    /artifact_name=.*GITHUB_RUN_ID.*GITHUB_RUN_ATTEMPT/
  );
});

for (const [job, cleanupName] of [
  ["build-binaries", "Delete temporary keychain"],
  ["build-macos-app", "Remove signing credentials"],
]) {
  test(`${job}: cleanup restores exact search list, deletes only owned secrets, and fails closed`, () => {
    const root = mkdtempSync(path.join(tmpdir(), "release-cleanup-test-"));
    try {
      const owned = path.join(root, "owned");
      const other = path.join(root, "unrelated");
      writeFileSync(other, "preserve");
      const security = path.join(root, "security");
      writeFileSync(
        security,
        '#!/usr/bin/env python3\nimport json,os,sys\nwith open(os.environ["CALLS"],"a") as f: f.write(json.dumps(sys.argv[1:])+"\\n")\nif os.environ.get("FAIL_RESTORE") and sys.argv[1]=="list-keychains": sys.exit(1)\n'
      );
      chmodSync(security, 0o755);
      const cleanup = step(job, cleanupName);
      assert.equal(cleanup.if, "always()");
      for (const fail of [false, true]) {
        const init = spawnSync("mkdir", ["-p", owned]);
        assert.equal(init.status, 0);
        writeFileSync(
          path.join(owned, "search-list.txt"),
          '    "/Users/test/Library/Keychains/custom with spaces.keychain-db"\n    "/Users/test/login.keychain-db"\n'
        );
        const keychain = path.join(owned, "signing.keychain-db");
        writeFileSync(keychain, "synthetic");
        writeFileSync(path.join(owned, "developer-id.p12"), "synthetic");
        const calls = path.join(root, fail ? "failed-calls" : "calls");
        const result = spawnSync("bash", ["-c", cleanup.run], {
          env: {
            ...process.env,
            PATH: `${root}:${process.env.PATH}`,
            SIGNING_DIR: owned,
            DISPATCH_NOTARY_KEYCHAIN: keychain,
            CALLS: calls,
            ...(fail ? { FAIL_RESTORE: "1" } : {}),
          },
          encoding: "utf8",
        });
        const recorded = readFileSync(calls, "utf8")
          .trim()
          .split("\n")
          .map(JSON.parse);
        assert.deepEqual(recorded[0], [
          "list-keychains",
          "-d",
          "user",
          "-s",
          "/Users/test/Library/Keychains/custom with spaces.keychain-db",
          "/Users/test/login.keychain-db",
        ]);
        if (fail) {
          assert.notEqual(result.status, 0);
          assert.equal(recorded.length, 1);
          assert.ok(existsSync(keychain));
        } else {
          assert.equal(result.status, 0, result.stderr);
          assert.deepEqual(recorded[1], ["delete-keychain", keychain]);
          assert.ok(!existsSync(owned));
        }
        assert.ok(existsSync(other));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("recovery execution rejects unsafe inputs and never bumps or pushes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "release-recovery-test-"));
  const sha = "0c9066545f5e3191ff34bb660a05801f1b1cf18a";
  try {
    const mock = `#!/usr/bin/env python3
import os,sys,json
args=sys.argv[1:]
with open(os.environ['CALLS'],'a') as f: f.write(json.dumps([os.path.basename(sys.argv[0]),*args])+'\\n')
if os.path.basename(sys.argv[0])=='node': print(os.environ.get('PACKAGE_VERSION', '1.7.10')); sys.exit(0)
if os.path.basename(sys.argv[0])=='gh': sys.exit(0 if os.environ.get('EXISTS') else 1)
if args==['rev-parse','HEAD']: print(os.environ['ACTUAL_SHA'])
if args and args[0]=='rev-parse' and args[1]!='HEAD': print(os.environ.get('ACTUAL_OBJECT', 'a'*40))
if args[:2]==['merge-base','--is-ancestor'] and os.environ.get('BAD_ANCESTRY'): sys.exit(1)
if args and args[0] in ['push','tag','commit']: sys.exit(99)
`;
    for (const command of ["git", "gh", "node"]) {
      const file = path.join(root, command);
      writeFileSync(file, mock);
      chmodSync(file, 0o755);
    }
    const script = step("prepare-release", "Prepare release commit")
      .run.replaceAll("${{ inputs.version }}", "patch")
      .replaceAll("${{ github.repository }}", "selfcontained/dispatch");
    const scenarios = [
      {},
      { RECOVERY_TAG: "v1.7.10;echo bad" },
      { RECOVERY_COMMIT: "" },
      { RECOVERY_TAG_OBJECT: "" },
      { ACTUAL_OBJECT: "b".repeat(40) },
      { ACTUAL_SHA: "f".repeat(40) },
      { BAD_ANCESTRY: "1" },
      { PACKAGE_VERSION: "1.7.9" },
      { EXISTS: "1" },
      { GITHUB_REF_NAME: "feature" },
    ];
    for (const [index, overrides] of scenarios.entries()) {
      const calls = path.join(root, `calls-${index}`);
      const output = path.join(root, `output-${index}`);
      const result = spawnSync("bash", ["-c", script], {
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_REF_NAME: "main",
          RECOVERY_TAG: "v1.7.10",
          RECOVERY_COMMIT: sha,
          RECOVERY_TAG_OBJECT: "a".repeat(40),
          ACTUAL_SHA: sha,
          GITHUB_OUTPUT: output,
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "1",
          CALLS: calls,
          ...overrides,
        },
        encoding: "utf8",
      });
      assert.equal(result.status === 0, index === 0, result.stderr);
      const recorded = existsSync(calls) ? readFileSync(calls, "utf8") : "";
      assert.doesNotMatch(recorded, /"(?:push|commit|tag)"/);
      if (index === 0)
        assert.match(
          readFileSync(output, "utf8"),
          new RegExp(`release_commit=${sha}`)
        );
      else assert.ok(!existsSync(output));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("appcast tests have dependencies and retries use producer artifact names", () => {
  const steps = workflow.jobs["build-macos-app"].steps;
  assert.ok(
    steps.findIndex((s) => s.run === "pnpm install --frozen-lockfile") <
      steps.findIndex((s) => s.name === "Test appcast publisher")
  );
  assert.equal(
    workflow.jobs["build-macos-app"].outputs.artifact_name,
    "${{ steps.artifact.outputs.name }}"
  );
  for (const job of ["publish-release", "publish-macos-appcast"]) {
    assert.ok(workflow.jobs[job].needs.includes("build-macos-app"));
    assert.equal(
      step(job, "Download macOS app").with.name,
      "${{ needs.build-macos-app.outputs.artifact_name }}"
    );
  }
});

test("publication fails before mutations when the remote tag object changes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "release-tag-guard-test-"));
  try {
    const gh = path.join(root, "gh");
    writeFileSync(
      gh,
      '#!/usr/bin/env python3\nimport os,sys\nif sys.argv[1]=="api": print(os.environ["REMOTE_OBJECT"]); sys.exit(0)\nwith open(os.environ["MUTATIONS"],"a") as f: f.write("mutation")\n'
    );
    chmodSync(gh, 0o755);
    for (const [job, name] of [
      ["publish-release", "Create GitHub prerelease from tested artifacts"],
      ["publish-macos-appcast", "Add the build to the preview channel"],
    ]) {
      const script = step(job, name)
        .run.replaceAll("${{ needs.prepare-release.outputs.tag }}", "v1.7.10")
        .replaceAll(
          "${{ needs.prepare-release.outputs.tag_object }}",
          "a".repeat(40)
        )
        .replaceAll("${{ github.repository }}", "selfcontained/dispatch");
      const mutations = path.join(root, "mutations");
      const result = spawnSync("bash", ["-c", script], {
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          REMOTE_OBJECT: "b".repeat(40),
          MUTATIONS: mutations,
        },
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /release tag object changed/);
      assert.ok(!existsSync(mutations));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
