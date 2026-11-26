import type { CheckoutView } from "@dispatch/runner-protocol";

/** Decoder for Dispatch checkout presentation data, including retained stats. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function totals(value: unknown) {
  return (
    isRecord(value) &&
    [value.files, value.added, value.deleted].every(
      (n) => Number.isSafeInteger(n) && Number(n) >= 0
    )
  );
}
function isFileDiff(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    (value.oldPath === undefined || typeof value.oldPath === "string") &&
    ["modified", "added", "deleted", "renamed"].includes(
      String(value.status)
    ) &&
    count(value.added) &&
    count(value.deleted) &&
    (value.diff === null || typeof value.diff === "string")
  );
}
export function isCheckoutViewData(view: CheckoutView, data: unknown) {
  switch (view.kind) {
    case "stats":
      return (
        data === null ||
        (isRecord(data) &&
          totals(data) &&
          totals(data.excludingTests) &&
          count(data.computedAt) &&
          (data.outcome === undefined ||
            data.outcome === "success" ||
            data.outcome === "partial"))
      );
    case "image":
      return (
        typeof data === "string" &&
        data.length <= 4 * Math.ceil((10 * 1024 * 1024) / 3) &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(data)
      );
    case "fileDiff":
      return (
        data === null ||
        (isFileDiff(data) && isRecord(data) && typeof data.diff === "string")
      );
    case "diff":
      return (
        isRecord(data) &&
        (data.baseRef === null || typeof data.baseRef === "string") &&
        Array.isArray(data.files) &&
        (data.truncatedFileCount === undefined ||
          count(data.truncatedFileCount)) &&
        data.files.every(
          (f) =>
            isFileDiff(f) &&
            isRecord(f) &&
            typeof f.isTest === "boolean" &&
            typeof f.truncated === "boolean" &&
            (f.image === undefined ||
              (isRecord(f.image) &&
                (f.image.revision === undefined ||
                  typeof f.image.revision === "string") &&
                [f.image.oldSize, f.image.newSize].every(
                  (n) => n === null || count(n)
                )))
        )
      );
    case "index":
      return (
        isRecord(data) &&
        (data.source === "git" || data.source === "folders") &&
        Array.isArray(data.paths) &&
        data.paths.every((p) => typeof p === "string") &&
        typeof data.truncated === "boolean"
      );
    case "directory":
      return (
        isRecord(data) &&
        typeof data.truncated === "boolean" &&
        Array.isArray(data.entries) &&
        data.entries.length <= 500 &&
        data.entries.every(
          (e) =>
            isRecord(e) &&
            typeof e.name === "string" &&
            e.path === (view.path ? view.path + "/" + e.name : e.name) &&
            !e.name.includes("/") &&
            ["file", "directory", "link", "other"].includes(String(e.kind))
        )
      );
    case "preview":
      return (
        isRecord(data) &&
        count(data.size) &&
        ((data.kind === "text" && typeof data.text === "string") ||
          (data.kind === "image" &&
            typeof data.src === "string" &&
            /^data:image\/(?:jpeg|png);base64,/.test(data.src)) ||
          (data.kind === "svg" &&
            typeof data.text === "string" &&
            typeof data.src === "string" &&
            data.src.startsWith("data:image/svg+xml;base64,")) ||
          (data.kind === "unsupported" && typeof data.message === "string"))
      );
  }
}
