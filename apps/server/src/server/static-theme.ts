type EmbeddedStaticAsset = {
  routePath: string;
  contentType: string;
  base64: string;
};

export const VALID_ICON_COLORS = [
  "teal",
  "blue",
  "purple",
  "red",
  "orange",
  "amber",
  "pink",
  "cyan",
] as const;

export type IconColor = (typeof VALID_ICON_COLORS)[number];

const DEFAULT_ICON_COLOR: IconColor = "teal";

export function createStaticThemeRuntime(
  embeddedStaticFiles: EmbeddedStaticAsset[]
) {
  const staticAssets = new Map(
    embeddedStaticFiles.map((asset) => [
      asset.routePath,
      {
        contentType: asset.contentType,
        body: Buffer.from(asset.base64, "base64"),
      },
    ])
  );

  const indexHtmlTemplate =
    staticAssets.get("/index.html")?.body.toString("utf8") ?? "";
  const manifestTemplate =
    staticAssets.get("/manifest.webmanifest")?.body.toString("utf8") ?? "";

  let cachedIconColor: IconColor = DEFAULT_ICON_COLOR;
  let cachedIndexHtml = indexHtmlTemplate;
  let cachedManifest = manifestTemplate;

  function rewriteForColor(color: IconColor): void {
    cachedIconColor = color;
    if (color === DEFAULT_ICON_COLOR) {
      cachedIndexHtml = indexHtmlTemplate;
      cachedManifest = manifestTemplate;
      return;
    }

    cachedIndexHtml = indexHtmlTemplate.replaceAll(
      "/icons/teal/",
      `/icons/${color}/`
    );
    cachedManifest = manifestTemplate.replaceAll(
      "/icons/teal/",
      `/icons/${color}/`
    );
  }

  return {
    staticAssets,
    getCachedIconColor: () => cachedIconColor,
    getCachedIndexHtml: () => cachedIndexHtml,
    getCachedManifest: () => cachedManifest,
    rewriteForColor,
  };
}
