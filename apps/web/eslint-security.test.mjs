import assert from "node:assert/strict";
import { test } from "node:test";
import { ESLint } from "eslint";

const eslint = new ESLint();
for (const expression of [
  "crypto.randomUUID()",
  "window.crypto.randomUUID()",
  "globalThis.crypto?.randomUUID?.()",
  'crypto["randomUUID"]()',
  "const { randomUUID } = crypto; randomUUID()",
  "const c = crypto; c.randomUUID()",
  "crypto.subtle.digest('SHA-256', new Uint8Array())",
  'const { subtle } = window.crypto; subtle.digest("SHA-256", new Uint8Array())',
]) {
  test(`reject secure-context API: ${expression}`, async () => {
    const [result] = await eslint.lintText(expression, {
      filePath: "src/example.ts",
    });
    assert.ok(
      result.messages.some(
        (message) => message.ruleId === "no-restricted-properties"
      )
    );
  });
}

test("allow random bytes over HTTP", async () => {
  const [result] = await eslint.lintText(
    "crypto.getRandomValues(new Uint8Array(16))",
    { filePath: "src/example.ts" }
  );
  assert.equal(result.errorCount, 0);
});
