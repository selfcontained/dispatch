import { readFile, writeFile } from "node:fs/promises";

const packageUrl = new URL(
  "../apps/browser-extension/package.json",
  import.meta.url
);
const manifestUrl = new URL(
  "../apps/browser-extension/public/manifest.json",
  import.meta.url
);

const packageJson = JSON.parse(await readFile(packageUrl, "utf8"));
const manifestSource = await readFile(manifestUrl, "utf8");
const manifest = JSON.parse(manifestSource);

if (manifest.version !== packageJson.version) {
  const versionFields = manifestSource.match(/"version"\s*:/g) ?? [];
  if (versionFields.length !== 1) {
    throw new Error(
      `Expected one version field in the browser extension manifest; found ${versionFields.length}.`
    );
  }

  const updatedManifest = manifestSource.replace(
    /("version"\s*:\s*")[^"]+("\s*,)/,
    `$1${packageJson.version}$2`
  );

  if (updatedManifest === manifestSource) {
    throw new Error("Could not update the browser extension manifest version.");
  }

  await writeFile(manifestUrl, updatedManifest);
  console.log(
    `Updated browser extension manifest version to ${packageJson.version}.`
  );
}
