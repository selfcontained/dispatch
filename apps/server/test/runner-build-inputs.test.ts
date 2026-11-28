import { readFile } from "node:fs/promises";
import ts from "typescript";
import { expect, it } from "vitest";

it("supplies build inputs at every embedding entry that consumes them", async () => {
  const source = await readFile(
    new URL("../../../packages/runner/src/program.ts", import.meta.url),
    "utf8"
  );
  const tree = ts.createSourceFile(
    "main.ts",
    source,
    ts.ScriptTarget.Latest,
    true
  );
  const required = new Map([
    ["runRunnerUpdateTrial", ["build"]],
    ["runCheckoutWorker", ["launchProbes"]],
    ["runRunnerUpdateStage", ["packageVersion"]],
    ["runRemoteRunner", ["build", "healthBuild"]],
    ["runCli", ["build"]],
    ["runAgentHost", ["build"]],
  ]);
  const found = new Set<string>();
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      const fields = required.get(name);
      if (fields) {
        found.add(name);
        const inputs =
          node.arguments[name === "createCheckoutWorkload" ? 0 : 1];
        expect(inputs && ts.isObjectLiteralExpression(inputs), name).toBe(true);
        if (inputs && ts.isObjectLiteralExpression(inputs)) {
          const names = inputs.properties.flatMap((property) =>
            property.name && ts.isIdentifier(property.name)
              ? [property.name.text]
              : []
          );
          for (const field of fields)
            expect(names, `${name}.${field}`).toContain(field);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  expect([...found].sort()).toEqual([...required.keys()].sort());
});
