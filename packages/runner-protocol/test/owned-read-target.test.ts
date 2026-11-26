import { expect, it } from "vitest";
import { operations, sessionFromWire } from "../src/contract/index.js";
const session = sessionFromWire("owned-reader");
it("accepts owned for file and presence reads, leaving other target schemas unchanged", () => {
  const target = { session, checkout: "owned" };
  expect(
    operations["checkout.read"].request.check({
      target,
      path: "file",
      encoding: "utf8",
      maxBytes: null,
    })
  ).toBe(true);
  expect(
    operations["checkout.access"].request.check({ target, path: "file" })
  ).toBe(true);
  expect(operations["checkout.list"].request.check({ target, path: "" })).toBe(
    false
  );
  expect(
    operations["checkout.write"].request.check({
      target,
      path: "file",
      data: "x",
      expectedDigest: null,
    })
  ).toBe(false);
  expect(
    operations["checkout.exec"].request.check({
      target,
      guard: { path: "file", digest: "d" },
      argv: ["true"],
      env: {},
      timeoutMs: null,
      maxOutput: null,
      shell: "direct",
    })
  ).toBe(false);
  expect(Object.keys(operations)).toHaveLength(74);
});
it.each([undefined, "current", "launch", "moved"] as const)(
  "keeps the existing read target: %s",
  (checkout) => {
    const target = { session, ...(checkout === undefined ? {} : { checkout }) };
    expect(
      operations["checkout.read"].request.check({
        target,
        path: "file",
        encoding: "base64",
        maxBytes: null,
      })
    ).toBe(true);
  }
);

it("requires an explicit session checkout for commands bound to a resolved directory", () => {
  const exec = operations["checkout.exec"].request;
  const command = {
    argv: ["true"],
    env: {},
    timeoutMs: 60_000,
    maxOutput: null,
    shell: "direct",
  };
  const guard = { root: "/root", identity: "1:2" };
  for (const checkout of ["current", "launch", "moved"])
    expect(
      exec.check({ ...command, guard, target: { session, checkout } })
    ).toBe(true);
  for (const target of [
    { session },
    { session, checkout: "owned" },
    { path: "/root" },
    { repository: "r" },
  ])
    expect(exec.check({ ...command, guard, target })).toBe(false);
  expect(
    exec.check({
      ...command,
      guard: { path: "file", digest: "d" },
      target: { session },
    })
  ).toBe(true);
});
