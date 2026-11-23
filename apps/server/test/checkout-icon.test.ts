/*
 * The icon scan reads a checkout through the runner's `checkout.list` and
 * `checkout.read`; its answer must match the host-filesystem scan, and the
 * raw bytes read must stay inside the checkout.
 */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runner } from "@dispatch/runner-protocol/contract";
import { checkoutWorkload } from "../src/agents/checkout-worker.js";
import { detectAgentIcon, readAgentIcon } from "../src/agents/checkout-icon.js";
import { detectRepoIcon } from "../src/shared/repo-icon.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "checkout-icon-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const runner = (root: string) =>
  ({
    call: (op: string, request: { target: unknown }) => {
      const { target: _, ...rest } = request;
      return checkoutWorkload.run(
        op as never,
        {
          directory: root,
          request: rest,
        } as never
      );
    },
  }) as unknown as Runner;
const agent = { id: "agt_icon" };
const put = async (rel: string, data: string | Buffer = "x") => {
  await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await writeFile(path.join(dir, rel), data);
};

describe("agent icon through the runner", () => {
  it("finds what the host scan finds", async () => {
    const layouts: string[][] = [
      [],
      ["favicon.svg", "favicon.png"],
      ["assets/logo.png", "src/deep/icon.ico", "node_modules/x/logo.svg"],
      [".dispatch/logo.png", "favicon.svg"],
      ["a/b/c/d/e/logo.svg"],
      ["brand.svg", "my-logo-dark.png", "README.md"],
    ];
    for (const files of layouts) {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir);
      for (const file of files) await put(file);
      expect(await detectAgentIcon(runner(dir), agent)).toBe(
        await detectRepoIcon(dir)
      );
    }
  });

  it("reads raw bytes, with a digest, from inside the checkout only", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 128]);
    await put("logo.png", png);
    await put("empty.svg", "");
    expect(await readAgentIcon(runner(dir), agent, "logo.png")).toEqual(png);
    const file = await runner(dir).call("checkout.read", {
      target: { session: "s" },
      path: "logo.png",
      encoding: "base64",
      maxBytes: null,
    } as never);
    expect(file).toEqual({
      data: png.toString("base64"),
      digest: createHash("sha256").update(png).digest("hex"),
    });
    expect(await readAgentIcon(runner(dir), agent, "empty.svg")).toEqual(
      Buffer.alloc(0)
    );
    expect(await readAgentIcon(runner(dir), agent, "missing.png")).toBeNull();

    const outside = await mkdtemp(path.join(tmpdir(), "checkout-icon-out-"));
    try {
      await writeFile(path.join(outside, "secret.png"), "secret");
      await symlink(
        path.join(outside, "secret.png"),
        path.join(dir, "out.png")
      );
      await mkdir(path.join(dir, "inner"));
      await symlink(path.join(dir, "logo.png"), path.join(dir, "inner/in.png"));
      expect(await readAgentIcon(runner(dir), agent, "out.png")).toBeNull();
      expect(await readAgentIcon(runner(dir), agent, "../x.png")).toBeNull();
      expect(await readAgentIcon(runner(dir), agent, "inner")).toBeNull();
      expect(await readAgentIcon(runner(dir), agent, "inner/in.png")).toEqual(
        png
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a file over the limit before reading it", async () => {
    await put("logo.png", "12345");
    await expect(
      runner(dir).call("checkout.read", {
        target: { session: "s" },
        path: "logo.png",
        encoding: "base64",
        maxBytes: 4,
      } as never)
    ).rejects.toMatchObject({ code: "too_large" });
  });

  it("treats a runner that cannot answer as no icon", async () => {
    const broken = {
      call: async () => {
        throw new Error("offline");
      },
    } as unknown as Runner;
    expect(await detectAgentIcon(broken, agent)).toBeNull();
    expect(await readAgentIcon(broken, agent, "logo.png")).toBeNull();
  });
});
