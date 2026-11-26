import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { loadCodeowners, parseCodeowners } from "../src/personas/codeowners.js";
import { checkoutWorkload } from "./helpers/checkout-workload.js";
import { ownerEvidence } from "./helpers/owned-checkout-fixture.js";

it("pins main's FIFO owner map against ordinary and native checkout reads", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "owner-fifo-"))
  );
  const owners = path.join(root, ".agents/owners.json");
  const content = JSON.stringify({
    version: 1,
    rules: [{ paths: ["src/**"], personas: ["fifo-owner"] }],
  });
  try {
    await mkdir(path.dirname(owners));
    execFileSync("mkfifo", [owners]);
    // Main waits for a writer and then includes the owner's subsystem.
    const main = loadCodeowners(root);
    await writeFile(owners, content);
    expect(ownerEvidence(await main)).toEqual({ "fifo-owner": 1 });
    // Ordinary checkout.read rejects non-regular entries before reading them.
    const ordinary = await checkoutWorkload
      .run("checkout.read", {
        directory: root,
        request: {
          path: ".agents/owners.json",
          encoding: "utf8",
          maxBytes: null,
        },
      })
      .then((reply) => (reply ? parseCodeowners(reply.data) : null))
      .catch(() => null);
    expect(ownerEvidence(ordinary)).toEqual({});
    const native = checkoutWorkload.run("checkout.read", {
      directory: root,
      request: {
        path: ".agents/owners.json",
        encoding: "utf8",
        maxBytes: null,
        mode: "native",
      },
    });
    await writeFile(owners, content);
    const reply = await native;
    expect(ownerEvidence(reply ? parseCodeowners(reply.data) : null)).toEqual({
      "fifo-owner": 1,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
