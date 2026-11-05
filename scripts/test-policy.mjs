#!/usr/bin/env node
// Browser admission and reliability ratchet. The manifest is reviewed code,
// not an automatically refreshed snapshot. Collection runs without a server.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export function inspectSource(source, file = "test.ts") {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const printer = ts.createPrinter({ removeComments: true });
  const risks = [];
  function visit(node) {
    let rule;
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(ast);
      if (
        /\.waitForTimeout$/.test(name) ||
        /^(?:setTimeout|(?:.*\.)?sleep)$/.test(name)
      )
        rule = "fixed-wait";
      if (
        /\.(?:skip|fixme|slow|setTimeout|setDefaultTimeout|setDefaultNavigationTimeout)$/.test(
          name
        )
      )
        rule = "skip-or-timeout";
      if (/\.only$/.test(name)) rule = "only";
    }
    if (ts.isStringLiteral(node) && node.text === "networkidle")
      rule = "networkidle";
    if (
      ts.isPropertyAssignment(node) ||
      ts.isShorthandPropertyAssignment(node)
    ) {
      const name = node.name.getText(ast).replace(/["']/g, "");
      if (
        ["retries", "timeout", "actionTimeout", "navigationTimeout"].includes(
          name
        )
      )
        // A shorthand hash would only cover the name, not its value. Require
        // explicit options so an exception cannot silently approve a binding.
        rule = ts.isShorthandPropertyAssignment(node)
          ? "shorthand-timeout-or-retry"
          : "timeout-or-retry";
    }
    if (rule) {
      const code = printer.printNode(ts.EmitHint.Unspecified, node, ast);
      const key = `${rule}:${createHash("sha256").update(code).digest("hex").slice(0, 16)}`;
      risks.push({
        key,
        rule,
        code,
        line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return risks;
}

export function collectedCases(report) {
  if (report.errors?.length)
    throw new Error("Playwright collection reported errors");
  const files = {};
  function walk(suite, parents = []) {
    const titles =
      suite.file && !suite.title.endsWith(".spec.ts")
        ? [...parents, suite.title]
        : parents;
    for (const spec of suite.specs ?? []) {
      const file = spec.file.startsWith("e2e/")
        ? spec.file
        : `e2e/${spec.file}`;
      for (const test of spec.tests ?? []) {
        // Project name intentionally excluded: runtime/project regrouping does
        // not change the scenario, but duplicate project selection still counts.
        (files[file] ??= []).push([...titles, spec.title].join(" > "));
      }
    }
    for (const child of suite.suites ?? []) walk(child, titles);
  }
  for (const suite of report.suites ?? []) walk(suite);
  if (!Object.keys(files).length)
    throw new Error("Playwright collected no tests");
  return files;
}

const counts = (items) =>
  items.reduce(
    (map, item) => map.set(item, (map.get(item) ?? 0) + 1),
    new Map()
  );
export function validatePolicy(
  policy,
  files,
  sources,
  today = new Date().toISOString().slice(0, 10)
) {
  const errors = [];
  if (policy.version !== 1 || !policy.files)
    return ["Invalid browser policy version/files"];
  for (const file of new Set([
    ...Object.keys(files),
    ...Object.keys(sources),
    ...Object.keys(policy.files),
  ])) {
    const entry = policy.files[file];
    if (!entry) {
      errors.push(`${file}: missing browser admission entry`);
      continue;
    }
    if (!sources[file] || (entry.layer !== "support" && !files[file]?.length)) {
      errors.push(`${file}: stale entry or uncollected spec`);
      continue;
    }
    if ((entry.layer === "support") === file.endsWith(".spec.ts")) {
      errors.push(`${file}: support entries must be helpers, not specs`);
    }
    for (const field of ["owner", "risk", "browserReason"]) {
      if (typeof entry[field] !== "string" || entry[field].trim().length < 8)
        errors.push(`${file}: explain ${field}`);
    }
    if (!["journey", "browser", "legacy", "support"].includes(entry.layer))
      errors.push(`${file}: invalid layer`);
    if (!Array.isArray(entry.cases) || !Array.isArray(entry.exceptions)) {
      errors.push(`${file}: missing cases/exceptions`);
      continue;
    }
    const actual = counts(files[file] ?? []);
    const approved = counts(entry.cases);
    for (const title of new Set([...actual.keys(), ...approved.keys()])) {
      if (actual.get(title) !== approved.get(title))
        errors.push(`${file}: unreviewed or stale case: ${title}`);
    }
    const risks = inspectSource(sources[file], file);
    const used = new Set();
    for (const [key, count] of counts(risks.map((risk) => risk.key))) {
      const risk = risks.find((item) => item.key === key);
      const exception = entry.exceptions.find((item) => item.key === key);
      used.add(key);
      if (
        risk.rule === "only" ||
        risk.rule === "networkidle" ||
        risk.rule === "shorthand-timeout-or-retry"
      ) {
        errors.push(`${file}:${risk.line}: ${risk.rule} is forbidden`);
        continue;
      }
      if (
        !exception ||
        exception.count !== count ||
        !exception.reason?.trim() ||
        !exception.owner?.trim() ||
        (exception.operation !== undefined &&
          exception.operation !== risk.code) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(exception.expires ?? "") ||
        !Number.isFinite(Date.parse(`${exception.expires}T00:00:00Z`)) ||
        new Date(`${exception.expires}T00:00:00Z`)
          .toISOString()
          .slice(0, 10) !== exception.expires ||
        exception.expires < today
      ) {
        errors.push(
          `${file}:${risk.line}: ${risk.rule} needs a current, counted owner/reason/expiry exception (${key})`
        );
      }
    }
    for (const exception of entry.exceptions)
      if (!used.has(exception.key))
        errors.push(`${file}: remove stale exception ${exception.key}`);
    if (
      new Set(entry.exceptions.map((item) => item.key)).size !==
      entry.exceptions.length
    )
      errors.push(`${file}: duplicate exceptions`);
  }
  return errors;
}

export function collect() {
  const report = JSON.parse(
    execFileSync(
      "pnpm",
      ["exec", "playwright", "test", "--list", "--reporter=json"],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      }
    )
  );
  const files = collectedCases(report);
  const sources = Object.fromEntries(
    readdirSync("e2e", { recursive: true })
      .filter((file) => file.endsWith(".ts") && !file.startsWith("fixtures/"))
      .map((file) => [`e2e/${file}`, readFileSync(`e2e/${file}`, "utf8")])
  );
  sources["playwright.config.ts"] = readFileSync(
    "playwright.config.ts",
    "utf8"
  );
  return { files, sources };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const { files, sources } = collect();
    if (process.argv.includes("--inventory")) {
      console.log(
        JSON.stringify(
          Object.fromEntries(
            Object.keys(sources).map((file) => [
              file,
              {
                cases: files[file] ?? [],
                risks: inspectSource(sources[file], file),
              },
            ])
          ),
          null,
          2
        )
      );
    } else {
      const errors = validatePolicy(
        JSON.parse(readFileSync("e2e/test-policy.json", "utf8")),
        files,
        sources
      );
      if (errors.length) throw new Error(errors.join("\n"));
      console.log(
        `Browser policy passed: ${Object.keys(files).length} files, ${Object.values(files).flat().length} cases. Manifest changes require owner review.`
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
