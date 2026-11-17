import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Inspect the actual JSX contract: bottom alone still permits Radix to flip.
describe("top sidebar dropdown placement", () => {
  for (const file of ["project-switcher.tsx", "agent-sidebar.tsx"]) {
    it(`${file} pins its menu below the trigger without flipping`, () => {
      const source = ts.createSourceFile(
        file,
        readFileSync(new URL(file, import.meta.url), "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      );
      const menus: ts.JsxOpeningElement[] = [];
      const visit = (node: ts.Node) => {
        if (
          ts.isJsxOpeningElement(node) &&
          node.tagName.getText(source) === "DropdownMenuContent"
        )
          menus.push(node);
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect(menus).toHaveLength(1);
      const attributes = menus[0].attributes.properties.map((prop) =>
        prop.getText(source)
      );
      expect(attributes).toContain('side="bottom"');
      expect(attributes).toContain("avoidCollisions={false}");
    });
  }
});
