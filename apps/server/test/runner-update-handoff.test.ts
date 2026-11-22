import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { requiresQuiescence } from "../src/agents/remote/update-handoff.js";
import {
  probeStagedRunner,
  readRunnerCompatibility,
} from "../src/agents/remote/update-probe.js";

vi.mock("node:child_process", { spy: true });
vi.mock("node:fs/promises", { spy: true });

// Frozen read-side projection of the pre-epoch supervisor's binding format.
function previousReader(raw: string) {
  const { scope, pid, start, marker } = JSON.parse(raw);
  if (
    typeof scope !== "string" ||
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    typeof start !== "string" ||
    !/^\d+$/.test(start) ||
    typeof marker !== "string" ||
    !/^DISPATCH_OWNED_[a-f0-9]{32}=1$/.test(marker)
  )
    throw new Error("Invalid runner host identity");
  return { scope, pid, start, marker };
}

it("preserves the N−1 reader's binding key and process identity", () => {
  const binding = {
    scope: "boot:namespace",
    pid: 100,
    start: "500",
    marker: "DISPATCH_OWNED_00000000000000000000000000000000=1",
  };
  const trial = {
    ...binding,
    handoffFormat: 2,
    sessionId: "../opaque",
    hostInstanceId: "01234567-89ab-4cde-8fab-0123456789ab",
    hostBuild: { version: "1.7.29", revision: "f".repeat(40) },
  };
  expect(previousReader(JSON.stringify(trial))).toEqual(
    previousReader(JSON.stringify(binding))
  );
});

describe("bidirectional handoff compatibility", () => {
  const previous = { reads: [1, 2], writes: 2 };
  const candidate = { reads: [2, 3], writes: 3 };

  it.each([
    ["compatible", [2], previous, { ...candidate, writes: 2 }, false],
    ["unreadable N−2", [2, 1], previous, { ...candidate, writes: 2 }, true],
    ["rollback cannot read trial writes", [2], previous, candidate, true],
    [
      "unknown retained identity",
      [2, null],
      previous,
      { ...candidate, writes: 2 },
      true,
    ],
    ["empty but rollback incompatible", [], previous, candidate, true],
    [
      "empty and rollback compatible",
      [],
      previous,
      { ...candidate, writes: 2 },
      false,
    ],
    ["probe failed", [], previous, null, true],
  ] as const)("%s", (_name, formats, old, next, expected) => {
    expect(requiresQuiescence(formats, old, next)).toBe(expected);
  });
});

describe("candidate compatibility probe", () => {
  const compatibility = {
    version: "1.7.29",
    revision: "f".repeat(40),
    handoff: { reads: [1, 2], writes: 2 },
  };
  const emit = (value: unknown, expectedVersion = compatibility.version) =>
    readRunnerCompatibility(
      process.execPath,
      ["-e", `process.stdout.write(${JSON.stringify(JSON.stringify(value))})`],
      expectedVersion
    );

  it("runs only the rehashed private copy in a fixed unprivileged systemd sandbox", async () => {
    const staging = await mkdtemp(path.join(tmpdir(), "runner-probe-sandbox-"));
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const { spawn } =
      await vi.importActual<typeof childProcess>("node:child_process");
    const { lstat } = await vi.importActual<typeof fs>("node:fs/promises");
    const candidate = "verified fixture";
    const sha256 = createHash("sha256").update(candidate).digest("hex");
    const target = {
      version: compatibility.version,
      os: "linux",
      arch: "x64",
      sha256,
    } as const;
    const runner = path.join(staging, `dispatch-${sha256}`);
    const installed = path.join(staging, "installed");
    const layout = { staging, config: "", installed, state: "" };
    let copy: string | undefined;
    try {
      await writeFile(runner, candidate, { mode: 0o700 });
      await writeFile(installed, "incumbent", { mode: 0o755 });
      Object.defineProperty(process, "platform", {
        ...platform,
        value: "linux",
      });
      vi.spyOn(process, "getuid").mockReturnValue(0);
      vi.mocked(fs.lstat).mockImplementation((async (file: string) =>
        Object.assign(await lstat(file), { uid: 0 })) as typeof fs.lstat);
      vi.mocked(childProcess.spawn).mockImplementation(((
        command: string,
        args: string[],
        options: childProcess.SpawnOptions
      ) => {
        expect(command).toBe("/usr/bin/systemd-run");
        expect(args).toEqual(
          expect.arrayContaining([
            "--wait",
            "--pipe",
            "--service-type=exec",
            "--property=User=nobody",
            "--property=Group=65534",
            "--property=CapabilityBoundingSet=",
            "--property=NoNewPrivileges=yes",
            "--property=TimeoutStartSec=5s",
            "--property=RuntimeMaxSec=5s",
            "--property=MemoryMax=512M",
            "--property=TasksMax=32",
            "--property=ProtectSystem=strict",
            "--property=ProtectHome=yes",
            "--property=PrivateTmp=yes",
            "--property=PrivateDevices=yes",
            "--property=PrivateNetwork=yes",
            "--property=RestrictNamespaces=yes",
            "--property=RestrictSUIDSGID=yes",
            "--property=SystemCallArchitectures=native",
            "--property=KillSignal=SIGKILL",
          ])
        );
        const bind = args.find((arg) =>
          arg.startsWith("--property=BindReadOnlyPaths=")
        );
        const [executable] = args.slice(-2);
        expect(executable).toBe(installed);
        accessSync(executable!, constants.X_OK);
        const suffix = `:${installed}`;
        expect(bind?.endsWith(suffix)).toBe(true);
        copy = bind?.slice(
          "--property=BindReadOnlyPaths=".length,
          -suffix.length
        );
        expect(path.dirname(copy!)).toBe(staging);
        expect(copy).not.toBe(runner);
        expect(readFileSync(copy!, "utf8")).toBe(candidate);
        expect(statSync(copy!).mode & 0o777).toBe(0o555);
        expect(args.slice(-3)).toEqual([
          "--",
          executable,
          "runner-update-compatibility",
        ]);
        return spawn(
          process.execPath,
          [
            "-e",
            `console.log(${JSON.stringify(JSON.stringify(compatibility))})`,
          ],
          options
        );
      }) as typeof childProcess.spawn);
      await expect(probeStagedRunner(layout, target)).resolves.toEqual(
        compatibility
      );
      await expect(stat(copy!)).rejects.toMatchObject({ code: "ENOENT" });
      expect(childProcess.execFile).not.toHaveBeenCalled();
      await writeFile(runner, "different bytes");
      await expect(probeStagedRunner(layout, target)).rejects.toThrow(
        "digest mismatch"
      );
      expect(childProcess.spawn).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(process, "platform", platform);
      vi.restoreAllMocks();
      vi.mocked(fs.lstat).mockReset();
      vi.mocked(childProcess.spawn).mockReset();
      await rm(staging, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "before exec",
      "Result=exit-code\nExecMainCode=0\nExecMainStatus=0\nExecStartPre={ path=/bin/false ; argv[]=/bin/false ; ignore_errors=no ; pid=42 ; code=exited ; status=1 }\n",
      " [result exit-code, ExecStartPre exited with status 1]",
    ],
    [
      "while entering its sandbox",
      "Result=exit-code\nExecMainCode=1\nExecMainStatus=226\n",
      " [result exit-code, main exit status 226]",
    ],
    [
      "by a signal",
      "Result=signal\nExecMainCode=2\nExecMainStatus=9\n",
      " [result signal, main signal 9]",
    ],
    [
      "with an excessive result",
      `Result=${"x".repeat(1000)}\n`,
      ` [result ${"x".repeat(249)}]`,
    ],
    [
      "without loading",
      "Result=success\nExecMainCode=0\nExecMainStatus=0\n",
      "",
    ],
    ["when systemctl cannot answer", null, ""],
  ])(
    "records and reaps a probe unit that fails %s",
    async (_, shown, detail) => {
      const staging = await mkdtemp(path.join(tmpdir(), "runner-probe-fail-"));
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      const { spawn } =
        await vi.importActual<typeof childProcess>("node:child_process");
      const { lstat } = await vi.importActual<typeof fs>("node:fs/promises");
      const sha256 = createHash("sha256").update("candidate").digest("hex");
      const installed = path.join(staging, "installed");
      const runner = path.join(staging, `dispatch-${sha256}`);
      const calls: string[][] = [];
      let unit: string | undefined;
      try {
        await writeFile(runner, "candidate", { mode: 0o700 });
        await writeFile(installed, "incumbent", { mode: 0o755 });
        Object.defineProperty(process, "platform", {
          ...platform,
          value: "linux",
        });
        vi.spyOn(process, "getuid").mockReturnValue(0);
        vi.mocked(fs.lstat).mockImplementation((async (file: string) =>
          Object.assign(await lstat(file), { uid: 0 })) as typeof fs.lstat);
        vi.mocked(childProcess.spawn).mockImplementation(((
          _command: string,
          args: string[],
          options: childProcess.SpawnOptions
        ) => {
          unit = args
            .find((arg) => arg.startsWith("--unit="))
            ?.slice("--unit=".length);
          // --collect would discard the result before it can be read.
          expect(args).not.toContain("--collect");
          return spawn("/bin/sh", ["-c", "exit 1"], options);
        }) as typeof childProcess.spawn);
        vi.mocked(childProcess.execFile).mockImplementation(((
          _command: string,
          args: string[],
          options: childProcess.ExecFileOptions,
          done: (error: Error | null, stdout: string) => void
        ) => {
          expect(options.timeout).toBeGreaterThan(0);
          expect(options.maxBuffer).toBeGreaterThan(0);
          calls.push(args);
          done(shown === null ? new Error("no bus") : null, shown ?? "");
        }) as typeof childProcess.execFile);
        await expect(
          probeStagedRunner(
            { staging, config: "", installed, state: "" },
            { version: "1.7.29", os: "linux", arch: "x64", sha256 }
          )
        ).rejects.toThrow(
          new Error(`Runner compatibility probe failed (exit 1)${detail}`)
        );
        expect(unit).toMatch(/^dispatch-runner-probe-[a-f0-9]{16}\.service$/);
        expect(calls).toEqual([
          [
            "show",
            "--property=Result",
            "--property=ExecMainCode",
            "--property=ExecMainStatus",
            "--property=ExecStartPre",
            unit,
          ],
          ["stop", unit],
          ["reset-failed", unit],
        ]);
      } finally {
        Object.defineProperty(process, "platform", platform);
        vi.restoreAllMocks();
        vi.mocked(fs.lstat).mockReset();
        vi.mocked(childProcess.spawn).mockReset();
        vi.mocked(childProcess.execFile).mockReset();
        await rm(staging, { recursive: true, force: true });
      }
    }
  );

  it("accepts bounded JSON for the expected version and projects its fields", async () => {
    await expect(emit({ ...compatibility, extra: "ignored" })).resolves.toEqual(
      compatibility
    );
  });

  it.each([
    { version: "1.7.30" },
    { revision: null },
    { revision: "f".repeat(12) },
    { handoff: { reads: Array(33).fill(2), writes: 2 } },
    { handoff: { reads: [2, "1"], writes: 2 } },
    { handoff: { reads: [2], writes: -1 } },
    { handoff: { reads: [1], writes: 2 } },
  ])("rejects malformed compatibility %j", async (override) => {
    await expect(emit({ ...compatibility, ...override })).rejects.toThrow(
      "Invalid runner compatibility response"
    );
  });

  it("rejects garbage and a nonzero exit", async () => {
    await expect(
      readRunnerCompatibility(
        "/bin/sh",
        ["-c", "printf garbage"],
        compatibility.version
      )
    ).rejects.toThrow("Invalid runner compatibility response");
    await expect(
      readRunnerCompatibility(
        "/bin/sh",
        ["-c", "echo fixture-diagnostic >&2; exit 1"],
        compatibility.version
      )
    ).rejects.toThrow("probe failed (exit 1): fixture-diagnostic");
  });

  it("caps combined stdout and stderr", async () => {
    await expect(
      readRunnerCompatibility(
        process.execPath,
        [
          "-e",
          "process.stdout.write('x'.repeat(3000)); process.stderr.write('x'.repeat(3000));",
        ],
        compatibility.version
      )
    ).rejects.toThrow("output was too large");
  });

  it("kills descendants when the probe exceeds the deadline", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "runner-probe-timeout-"));
    const marker = path.join(dir, "survived");
    try {
      await expect(
        readRunnerCompatibility(
          "/bin/sh",
          ["-c", '(sleep 0.3; touch "$1") & wait', "probe", marker],
          compatibility.version,
          100
        )
      ).rejects.toThrow("timed out");
      await delay(350);
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
