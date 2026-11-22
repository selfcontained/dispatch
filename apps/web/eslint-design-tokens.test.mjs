import assert from "node:assert/strict";
import { test } from "node:test";
import { ESLint } from "eslint";

const eslint = new ESLint();

async function violations(source, filePath = "src/example.tsx") {
  const [result] = await eslint.lintText(source, { filePath });
  return result.messages
    .filter(({ ruleId }) => ruleId === "dispatch/design-tokens")
    .map(({ messageId }) => messageId);
}

for (const [className, id] of [
  ["text-[11px]", "fontSize"],
  ["md:text-[0.85em]", "fontSize"],
  ["text-xs", "fontSize"],
  ["pointer-coarse:text-base", "fontSize"],
  ["text-red-300", "palette"],
  ["border-x-amber-500/30", "palette"],
  ["bg-[#101014]", "palette"],
  ["[[data-theme-mode=dark]_&]:text-sky-300", "palette"],
  ["bg-white/[0.04]", "whiteBlack"],
  ["border-l-white/20", "whiteBlack"],
  ["!text-black", "whiteBlack"],
  ["hover:shadow-[0_1px_4px_rgba(0,0,0,0.2)]", "shadow"],
  ["flex rounded", "bareRounded"],
  ["rounded-r", "bareRounded"],
  ["rounded-[4px]", "radius"],
  ["rounded-t-2xl", "radius"],
  ["bg-muted/30", "alpha"],
  ["border-foreground/[0.22]", "alpha"],
  ["z-[70]", "zIndex"],
  ["z-10", "zIndex"],
]) {
  test(`reject ${className}`, async () => {
    assert.deepEqual(
      await violations(`export const a = <div className="${className}" />;`),
      [id]
    );
  });
}

test("check template literals", async () => {
  assert.deepEqual(
    await violations("export const c = (x: string) => `p-2 text-[9px] ${x}`;"),
    ["fontSize"]
  );
});

test("allow tokens, prose and fractions", async () => {
  const source = [
    "text-body-sm text-label-xs rounded-sm rounded-[inherit] z-modal z-0",
    "bg-danger/tint border-danger/line shadow-elev-overlay text-muted-foreground",
    "w-1/2 translate-x-1/2 bg-[hsl(var(--log-stream-bg))]",
    "The result is rounded to two places.",
  ]
    .map(
      (text, index) => `export const value${index} = ${JSON.stringify(text)};`
    )
    .join("\n");
  assert.deepEqual(await violations(source), []);
});

test("leave test fixtures alone", async () => {
  assert.deepEqual(
    await violations(
      'export const fixture = "text-[11px] bg-white";',
      "src/example.test.tsx"
    ),
    []
  );
});

async function controlViolations(source, filePath = "src/example.tsx") {
  const [result] = await eslint.lintText(source, { filePath });
  return result.messages
    .filter(({ ruleId }) => ruleId === "dispatch/controls")
    .map(({ messageId }) => messageId);
}

for (const [jsx, id] of [
  ["<button>Go</button>", "rawButton"],
  ['<Button className="h-7" />', "sizing"],
  ['<Button className="sm:min-h-11" />', "sizing"],
  ['<IconButton label="Go" className="size-9" />', "sizing"],
  ['<Button className={cn("w-full", open && "!px-1")} />', "sizing"],
  ["<SplitButton className={SIZED} />", "sizing"],
  ['<Button size="icon-sm" />', "iconButton"],
  ['<IconButton label="Go" title="Go" />', "title"],
]) {
  test(`reject ${jsx}`, async () => {
    assert.deepEqual(
      await controlViolations(`const SIZED = "py-2"; export const a = ${jsx};`),
      [id]
    );
  });
}

test("allow a control's size, width, offset and pseudo-element", async () => {
  assert.deepEqual(
    await controlViolations(
      'export const a = <Button size="xs" className="-mt-1 w-full after:size-7" />;'
    ),
    []
  );
});

test("leave the stream and components/ui to their own sizes", async () => {
  for (const file of [
    "src/components/app/chat/example.tsx",
    "src/components/ui/example.tsx",
  ]) {
    assert.deepEqual(
      await controlViolations("export const a = <button />;", file),
      []
    );
  }
});
