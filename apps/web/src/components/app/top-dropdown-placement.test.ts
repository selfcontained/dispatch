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
      const menus: string[][] = [];
      const visit = (node: ts.Node) => {
        if (ts.isJsxOpeningElement(node)) {
          const tag = node.tagName.getText(source);
          if (tag === "DropdownMenuContent")
            menus.push(
              node.attributes.properties.map((prop) => prop.getText(source))
            );
          // A SplitButton hands the same props to its menu as an object.
          if (tag === "SplitButton")
            for (const prop of node.attributes.properties)
              if (
                ts.isJsxAttribute(prop) &&
                prop.name.getText(source) === "menuProps"
              )
                menus.push([prop.getText(source)]);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect(menus).toHaveLength(1);
      const attributes = menus[0].join(" ");
      expect(attributes).toMatch(/side(="bottom"|: "bottom")/);
      expect(attributes).toMatch(/avoidCollisions(=\{false\}|: false)/);
    });
  }
});
