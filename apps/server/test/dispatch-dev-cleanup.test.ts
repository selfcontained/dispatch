import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const bin = path.resolve(import.meta.dirname, "../../../bin/dispatch-dev");
const dirs: string[] = [];
const states: string[] = [];
afterEach(() => {
  for (const file of states.splice(0)) rmSync(file, { force: true });
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fixture(docker?: string) {
  const dir = mkdtempSync("/tmp/dispatch-cleanup-regression-");
  dirs.push(dir);
  const tools = path.join(dir, "bin");
  mkdirSync(tools);
  // Deliberately omit Node, pnpm, and real Docker from the service PATH.
  for (const name of ["bash", "dirname", "mkdir", "rm"]) {
    const resolved = spawnSync("/bin/sh", ["-c", `command -v ${name}`], {
      encoding: "utf8",
    }).stdout.trim();
    symlinkSync(resolved, path.join(tools, name));
  }
  if (docker)
    writeFileSync(path.join(tools, "docker"), `#!/bin/bash\n${docker}\n`, {
      mode: 0o755,
    });
  const suffix = path.basename(dir).toLowerCase();
  const state = `/tmp/dispatch-dev-${suffix}.env`;
  states.push(state);
  writeFileSync(
    state,
    `DEV_SUFFIX=${suffix}\nDEV_COMPOSE_PROJECT=dispatch-dev-${suffix}\nDEV_NO_DB=0\n`
  );
  const project = `dispatch-dev-${suffix}`;
  const volume = `${project}_db-data`;
  const volumeFile = path.join(dir, "volume");
  writeFileSync(volumeFile, "");
  const run = (wipe = false, target = suffix) =>
    spawnSync(
      "/bin/bash",
      [bin, "down", "--suffix", target, ...(wipe ? ["--wipe"] : [])],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: tools,
          FIXTURE_PROJECT: project,
          FIXTURE_VOLUME: volume,
          FIXTURE_VOLUME_FILE: volumeFile,
        },
      }
    );
  return { run, state, volume, volumeFile };
}

// Model Docker's ownership metadata and refusal to delete referenced data.
const ownedDocker = `
case "$1 $2" in
  'compose version') exit 0 ;;
  "compose -f")
    [ "$5" = "$FIXTURE_PROJECT" ] && [ "$6" = down ] && [ "$#" = 6 ]
    ;;
  'volume ls')
    printf '%s\n' "$FIXTURE_VOLUME-neighbor"
    if [ -f "$FIXTURE_VOLUME_FILE" ]; then printf '%s\n' "$FIXTURE_VOLUME"; fi
    ;;
  'volume inspect')
    [ "$5" = "$FIXTURE_VOLUME" ] || exit 42
    printf '%s db-data\n' "$FIXTURE_PROJECT"
    ;;
  'volume rm')
    [ "$3" = "$FIXTURE_VOLUME" ] && [ "$#" = 3 ] || exit 42
    if [ -s "$FIXTURE_VOLUME_FILE" ]; then
      echo 'volume is in use' >&2
      exit 1
    fi
    rm "$FIXTURE_VOLUME_FILE"
    ;;
  *) exit 42 ;;
esac
`;

describe("dev teardown from a minimal service environment", () => {
  it("removes a database without requiring Node or pnpm", () => {
    const { run, state, volume, volumeFile } = fixture(ownedDocker);
    const result = run(true);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Removed database volume '${volume}'`);
    expect(existsSync(volumeFile)).toBe(false);
    expect(existsSync(state)).toBe(false);
  });
  it("keeps the database on stop, then wipes only the exact volume without state", () => {
    const { run, state, volumeFile } = fixture(ownedDocker);
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("data kept");
    expect(existsSync(state)).toBe(false);
    expect(existsSync(volumeFile)).toBe(true);

    expect(run(true).stdout).toContain("Removed database volume");
    expect(existsSync(volumeFile)).toBe(false);
    const repeat = run(true);
    expect(repeat.status).toBe(0);
    expect(repeat.stdout).toContain("No database volume found");
  });

  it("rejects an invalid or missing target before touching the stack", () => {
    const { run, state, volumeFile } = fixture(ownedDocker);
    expect(run(true, "../unrelated").stderr).toContain("Invalid stack suffix");
    expect(run(true, "").stderr).toContain("--suffix requires a stack name");
    expect(existsSync(state)).toBe(true);
    expect(existsSync(volumeFile)).toBe(true);
  });

  it("preserves a volume with ambiguous ownership", () => {
    const { run, state, volumeFile } = fixture(
      ownedDocker.replace("%s db-data", "%s unrelated")
    );
    const result = run(true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ownership labels did not match");
    expect(existsSync(state)).toBe(true);
    expect(existsSync(volumeFile)).toBe(true);
  });

  it("preserves an in-use volume and can retry after the reference is gone", () => {
    const { run, state, volumeFile } = fixture(ownedDocker);
    writeFileSync(volumeFile, "referenced");
    const failed = run(true);
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain("volume is in use");
    expect(failed.stderr).toContain("retry down --wipe");
    expect(existsSync(state)).toBe(false);
    expect(existsSync(volumeFile)).toBe(true);

    writeFileSync(volumeFile, "");
    expect(run(true).status).toBe(0);
    expect(existsSync(volumeFile)).toBe(false);
  });

  it("preserves tracking state when Docker is unavailable", () => {
    const { run, state } = fixture();
    const before = readFileSync(state, "utf8");
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Docker Compose is unavailable");
    expect(readFileSync(state, "utf8")).toBe(before);
  });
  it("preserves state and exposes Docker teardown errors", () => {
    const { run, state } = fixture(
      'if [ "$2" = version ]; then exit 0; fi\necho "daemon unavailable" >&2\nexit 1'
    );
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("daemon unavailable");
    expect(result.stderr).toContain("retained state");
    expect(existsSync(state)).toBe(true);
    expect(result.stdout).not.toContain("Removed database container");
  });
});
