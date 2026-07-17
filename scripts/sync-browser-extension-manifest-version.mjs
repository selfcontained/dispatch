import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const packageUrl = new URL(
  "../apps/browser-extension/package.json",
  import.meta.url
);
const manifestUrl = new URL(
  "../apps/browser-extension/public/manifest.json",
  import.meta.url
);

export function synchronizeManifestVersion(manifestSource, packageVersion) {
  if (
    typeof packageVersion !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(packageVersion)
  ) {
    throw new Error(
      `Invalid browser extension package version: ${packageVersion}`
    );
  }

  const sourceFile = ts.parseJsonText("manifest.json", manifestSource);
  if (sourceFile.parseDiagnostics.length > 0) {
    const diagnostic = sourceFile.parseDiagnostics[0];
    throw new Error(
      `Invalid browser extension manifest JSON: ${ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        "\n"
      )}`
    );
  }

  const root = sourceFile.statements[0]?.expression;
  if (!root || !ts.isObjectLiteralExpression(root)) {
    throw new Error("Browser extension manifest must be a JSON object.");
  }

  const versionProperties = root.properties.filter(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ts.isStringLiteral(property.name) &&
      property.name.text === "version"
  );
  if (versionProperties.length !== 1) {
    throw new Error(
      `Expected one top-level version field in the browser extension manifest; found ${versionProperties.length}.`
    );
  }

  const versionProperty = versionProperties[0];
  if (!ts.isStringLiteral(versionProperty.initializer)) {
    throw new Error("Browser extension manifest version must be a string.");
  }

  let updatedManifest = manifestSource;
  if (versionProperty.initializer.text !== packageVersion) {
    const start = versionProperty.initializer.getStart(sourceFile);
    const end = versionProperty.initializer.getEnd();
    updatedManifest =
      manifestSource.slice(0, start) +
      JSON.stringify(packageVersion) +
      manifestSource.slice(end);
  }

  const reparsed = JSON.parse(updatedManifest);
  if (
    !Object.prototype.hasOwnProperty.call(reparsed, "version") ||
    reparsed.version !== packageVersion
  ) {
    throw new Error(
      "Browser extension manifest version did not synchronize with the package version."
    );
  }

  return {
    changed: updatedManifest !== manifestSource,
    source: updatedManifest,
  };
}

async function main() {
  const packageJson = JSON.parse(await readFile(packageUrl, "utf8"));
  const manifestSource = await readFile(manifestUrl, "utf8");
  const result = synchronizeManifestVersion(
    manifestSource,
    packageJson.version
  );

  if (result.changed) {
    await writeFile(manifestUrl, result.source);
    console.log(
      `Updated browser extension manifest version to ${packageJson.version}.`
    );
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
