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
  expect(Object.keys(operations)).toHaveLength(73);
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
