import { requestCheckoutCommand } from "../src/agents/checkout-commands.js";
import { MAX_CHECKOUT_COMMAND_FILE_BYTES } from "@dispatch/runner-protocol";
import { checkoutWorkload } from "./helpers/checkout-workload.js";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  pathFromWire,
  sessionFromWire,
  type Req,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import { RemoteRunnerService } from "../src/agents/remote/service.js";
import { checkoutRunners } from "../src/runners/directory.js";
import {
  controllerPlacement,
  placementForRunner,
} from "../src/runners/placement.js";

const agent = {
  id: "agt_123",
  cwd: "/checkout",
  placement: controllerPlacement,
  worktreePath: null,
  workspacePath: null,
};
const path = ".dispatch/tools.json";
const state = "a".repeat(64);
const argv = ["example", "a b", "$literal"];
const req: Req<"checkout.exec"> = {
  target: { session: sessionFromWire(agent.id), checkout: "current" },
  guard: { path, digest: state },
  argv,
  env: {},
  timeoutMs: null,
  maxOutput: null,
  shell: "direct",
};
describe("checkout.exec", () => {
  it("reads a large local command manifest and enforces the enrolled UTF-8 ceiling", async () => {
    const root = await mkdtemp(join(tmpdir(), "manifest-limit-"));
    const read = {
      kind: "read",
      checkout: "effective",
      path: "manifest",
    } as const;
    const text = "é".repeat(MAX_CHECKOUT_COMMAND_FILE_BYTES / 2);
    try {
      await writeFile(join(root, read.path), text + "é");
      await expect(
        requestCheckoutCommand({}, { ...agent, cwd: root }, read)
      ).resolves.toMatchObject({ content: text + "é" });
      const enrolled = {
        ...agent,
        cwd: "/runner/session",
        placement: placementForRunner("enrolled"),
      };
      const call = vi.fn(async (_id, op, input) => {
        expect(op).toBe("checkout.read");
        expect(input).toMatchObject({
          mode: "command-manifest",
          encoding: "utf8",
          maxBytes: MAX_CHECKOUT_COMMAND_FILE_BYTES,
        });
        return { data: text, digest: state };
      });
      const remote = { call } as unknown as RemoteRunnerService;
      expect(await requestCheckoutCommand({ remote }, enrolled, read)).toEqual({
        content: text,
        state,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs a local call in the workload, on the request's terms", async () => {
    const root = await mkdtemp(join(tmpdir(), "checkout-runner-"));
    try {
      await mkdir(join(root, ".dispatch"));
      await writeFile(join(root, path), "{}");
      const local = { ...agent, cwd: root };
      const { directory, placement } = checkoutRunners({}, local);
      const runner = directory.for(placement);
      const file = await runner.call("checkout.read", {
        target: req.target,
        mode: "command-manifest",
        encoding: "utf8",
        maxBytes: null,
        path,
      });
      expect(file?.data).toBe("{}");
      const call = (
        patch: Partial<
          Extract<Req<"checkout.exec">, { guard: { digest: string } }>
        >
      ) =>
        runner.call("checkout.exec", {
          ...req,
          guard: { path, digest: file!.digest! },
          argv: [
            "sh",
            "-c",
            'printf %70000s "" | tr " " x; printf "$DISPATCH_AGENT_ID" >&2',
          ],
          env: { DISPATCH_AGENT_ID: agent.id },
          ...patch,
        });
      // No output limit unless the request names one, as main ran repo tools.
      const result = await call({});
      expect(result.stdout).toHaveLength(70_000);
      expect(result.stderr).toBe(agent.id);
      expect(result).not.toHaveProperty("truncated");
      await expect(call({ maxOutput: 10 })).resolves.toMatchObject({
        stdout: "x".repeat(10),
        truncated: true,
      });
      await expect(
        call({ guard: { path, digest: state } })
      ).rejects.toMatchObject({ code: "stale" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a resolved command when its session selects a different directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "checkout-guard-"));
    try {
      const checkout = await mkdtemp(join(directory, "owned-"));
      await writeFile(join(checkout, "manifest"), "{}");
      const local = { ...agent, cwd: checkout };
      const binding = checkoutRunners({}, local);
      const runner = binding.directory.for(binding.placement);
      const target = {
        session: sessionFromWire(agent.id),
        checkout: "launch" as const,
      };
      const file = await runner.call("checkout.read", {
        target: { ...target, checkout: "owned" },
        path: "manifest",
        mode: "native",
        encoding: "utf8",
        maxBytes: null,
        bindRoot: true,
      });
      await expect(
        runner.call("checkout.exec", {
          ...req,
          target,
          guard: {
            root: pathFromWire(directory),
            identity: file!.rootIdentity!,
          },
          argv: ["sh", "-c", "touch invoked"],
        })
      ).rejects.toMatchObject({ code: "stale" });
      await expect(stat(join(checkout, "invoked"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("runs a local call in the child only when it holds the selected checkout", async () => {
    const child = {
      connection: { state: "ready", epoch: 1, onChange: () => () => {} },
      call: vi.fn(async (op: string) => {
        if (op === "workspace.describe")
          return {
            path: pathFromWire("/moved"),
            moved: true,
            origin: null,
            checkoutRoot: pathFromWire("/checkout"),
            worktree: null,
          };
        return { exitCode: 0, stdout: "child", stderr: "" };
      }),
    } as unknown as Runner;
    const moved = { ...agent, workspacePath: "/moved" };
    const { directory, placement } = checkoutRunners(
      { child: () => child },
      moved
    );
    const runner = directory.for(placement);
    for (const checkout of ["current", "launch", "moved"] as const)
      await expect(
        runner.call("checkout.exec", {
          ...req,
          target: { session: req.target.session, checkout } as never,
        })
      ).resolves.toMatchObject({ stdout: "child" });
    expect(
      child.call.mock.calls
        .filter(([op]) => op === "checkout.exec")
        .map(([, input]) => (input as Req<"checkout.exec">).target)
    ).toEqual(
      ["current", "launch", "moved"].map((checkout) => ({
        session: req.target.session,
        checkout,
      }))
    );

    // A binding elsewhere: the workload runs it here, against its own guard.
    const elsewhere = checkoutRunners(
      { child: () => child },
      { ...agent, cwd: "/other" }
    );
    await expect(
      elsewhere.directory.for(elsewhere.placement).call("checkout.exec", req)
    ).rejects.toThrow();
    expect(
      child.call.mock.calls.filter(([op]) => op === "checkout.exec")
    ).toHaveLength(3);
  });
});

describe("enrolled checkout reads", () => {
  const enrolled = {
    ...agent,
    cwd: "/runner/session",
    placement: placementForRunner("enrolled"),
  };
  it("streams launch files from the owned checkout and current files from the selected workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "read-selectors-"));
    const owned = join(root, "owned");
    const moved = join(root, "moved");
    await mkdir(owned);
    await mkdir(moved);
    const ownedBytes = Buffer.alloc(5 * 1024 * 1024, 0xff);
    ownedBytes.set([0, 128, 239, 127]);
    const movedBytes = Buffer.alloc(5 * 1024 * 1024, 0x80);
    const ownedText = "owned¥".repeat(1024 * 1024);
    const movedText = "moved¥".repeat(1024 * 1024);
    try {
      for (const [directory, bytes, data] of [
        [owned, ownedBytes, ownedText],
        [moved, movedBytes, movedText],
      ] as const) {
        await writeFile(join(directory, "binary"), bytes);
        await writeFile(join(directory, "text"), data);
      }
      const streamCheckoutRead = vi.fn(async (_location, op, request) => {
        const { target, ...parameters } = request;
        return checkoutWorkload.run(
          op,
          {
            directory: target.checkout === "launch" ? owned : moved,
            request: parameters,
          },
          {}
        );
      });
      const { directory, placement: selected } = checkoutRunners(
        { remote: { call: streamCheckoutRead } as never },
        enrolled
      );
      for (const checkout of ["current", "launch"] as const) {
        const call = (
          encoding: "utf8" | "base64",
          maxBytes: number | null = null
        ) =>
          directory.for(selected).call("checkout.read", {
            target: { session: sessionFromWire(enrolled.id), checkout },
            path: encoding === "base64" ? "binary" : "text",
            encoding,
            maxBytes,
          });
        const binary = await call("base64");
        expect(
          Buffer.from(binary!.data, "base64").equals(
            checkout === "launch" ? ownedBytes : movedBytes
          )
        ).toBe(true);
        const text = await call("utf8");
        expect(
          text?.data === (checkout === "launch" ? ownedText : movedText)
        ).toBe(true);
        await expect(call("utf8", 1)).rejects.toMatchObject({
          code: "too_large",
        });
        await expect(call("base64", 1)).rejects.toMatchObject({
          code: "too_large",
        });
      }
      expect(streamCheckoutRead).toHaveBeenCalledTimes(8);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
