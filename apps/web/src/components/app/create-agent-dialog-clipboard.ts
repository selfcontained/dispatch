import type { ClipboardEvent } from "react";

// The accepted-extension list now lives in a dependency-free lib module;
// re-exported here so existing importers of this module keep working without
// lib depending on a feature component (and without pulling in media-upload's
// browser-only transitive deps, which break non-jsdom unit tests).
export { STARTUP_FILE_ACCEPT } from "@/lib/media-accept";

const URL_PROTOCOLS = new Set(["http:", "https:"]);

export function startupFileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export function startupFileExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1
    ? "FILE"
    : name
        .slice(dot + 1)
        .toUpperCase()
        .slice(0, 4);
}

export function startupLinkLabel(url: string): { host: string; rest: string } {
  try {
    const u = new URL(url);
    const rest =
      (u.pathname === "/" ? "" : u.pathname) +
      (u.search || "") +
      (u.hash || "");
    return { host: u.hostname.replace(/^www\./, ""), rest };
  } catch {
    return { host: url, rest: "" };
  }
}

export type ClipboardSuggestion =
  | {
      kind: "image" | "file";
      title: string;
      description: string;
      actionLabel: string;
      file: File;
    }
  | {
      kind: "url";
      title: string;
      description: string;
      actionLabel: string;
      url: string;
    }
  | {
      kind: "text";
      title: string;
      description: string;
      actionLabel: string;
      text: string;
    };

export type ClipboardLookupResult =
  | {
      suggestion: ClipboardSuggestion;
      canRead: boolean;
      status: "found";
    }
  | {
      suggestion: null;
      canRead: boolean;
      status: "empty" | "blocked" | "unsupported";
    };

export function isLikelyUrl(value: string): boolean {
  return normalizeUrl(value) !== null;
}

export function normalizeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (URL_PROTOCOLS.has(parsed.protocol)) return trimmed;
    return null;
  } catch {
    try {
      const withProtocol = `https://${trimmed}`;
      const parsed = new URL(withProtocol);
      if (parsed.hostname.includes(".")) return withProtocol;
      return null;
    } catch {
      return null;
    }
  }
}

export function describeClipboardFileType(type: string): {
  noun: string;
  actionLabel: string;
} {
  if (type.startsWith("image/")) {
    return {
      noun: "image",
      actionLabel: "Add clipboard image",
    };
  }
  if (type === "application/pdf") {
    return {
      noun: "PDF",
      actionLabel: "Add clipboard PDF",
    };
  }
  if (type.startsWith("video/")) {
    return {
      noun: "video",
      actionLabel: "Add clipboard video",
    };
  }
  if (type.startsWith("audio/")) {
    return {
      noun: "audio file",
      actionLabel: "Add clipboard audio",
    };
  }
  if (type.startsWith("text/")) {
    return {
      noun: "text file",
      actionLabel: "Add clipboard file",
    };
  }
  return {
    noun: "file",
    actionLabel: "Add clipboard file",
  };
}

export function isClipboardAttachmentType(type: string): boolean {
  return (
    type.startsWith("image/") ||
    type.startsWith("video/") ||
    type.startsWith("audio/") ||
    type === "application/pdf"
  );
}

export function extensionForMimeType(type: string): string {
  switch (type) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "application/pdf":
      return "pdf";
    case "text/plain":
      return "txt";
    case "text/markdown":
      return "md";
    case "application/json":
      return "json";
    default: {
      const subtype = type.split("/")[1]?.split(";")[0]?.trim();
      return subtype || "bin";
    }
  }
}

export function createClipboardFile(blob: Blob): File {
  const type = blob.type || "application/octet-stream";
  const { noun } = describeClipboardFileType(type);
  const baseName = noun === "image" ? "clipboard-image" : "clipboard-file";
  return new File([blob], `${baseName}.${extensionForMimeType(type)}`, {
    type,
    lastModified: Date.now(),
  });
}

export function createClipboardSuggestionFromFile(
  file: File
): ClipboardSuggestion {
  const typeInfo = describeClipboardFileType(file.type);
  return {
    kind: file.type.startsWith("image/") ? "image" : "file",
    title: file.type.startsWith("image/")
      ? "Clipboard image ready"
      : "Clipboard file ready",
    description: `Add copied ${typeInfo.noun}?`,
    actionLabel: typeInfo.actionLabel,
    file,
  };
}

export function createClipboardSuggestionFromText(
  text: string
): ClipboardSuggestion | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const normalized = normalizeUrl(trimmed);
  if (normalized) {
    return {
      kind: "url",
      title: "Copied link ready",
      description: "Add copied link?",
      actionLabel: "Add copied link",
      url: normalized,
    };
  }
  return {
    kind: "text",
    title: "Copied prompt ready",
    description: "Use copied text as instructions?",
    actionLabel: "Use copied text",
    text: trimmed,
  };
}

export function getClipboardFilesFromEvent(
  event: ClipboardEvent<HTMLElement>
): File[] {
  return Array.from(event.clipboardData.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

export function clipboardReadSupported(): boolean {
  if (typeof navigator === "undefined" || !navigator.clipboard) {
    return false;
  }

  return (
    typeof navigator.clipboard.read === "function" ||
    typeof navigator.clipboard.readText === "function"
  );
}

export async function getClipboardSuggestion(): Promise<ClipboardLookupResult> {
  if (typeof navigator === "undefined" || !navigator.clipboard) {
    return {
      suggestion: null,
      canRead: false,
      status: "unsupported",
    };
  }

  const canRead = clipboardReadSupported();

  if (typeof navigator.clipboard.read === "function") {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const fileType = item.types.find(isClipboardAttachmentType);
        if (!fileType) continue;
        const blob = await item.getType(fileType);
        return {
          suggestion: createClipboardSuggestionFromFile(
            createClipboardFile(blob)
          ),
          canRead,
          status: "found",
        };
      }
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "name" in error &&
        typeof error.name === "string" &&
        ["NotAllowedError", "SecurityError"].includes(error.name)
      ) {
        return {
          suggestion: null,
          canRead,
          status: "blocked",
        };
      }
    }
  }

  if (typeof navigator.clipboard.readText === "function") {
    try {
      const suggestion = createClipboardSuggestionFromText(
        await navigator.clipboard.readText()
      );
      return suggestion
        ? {
            suggestion,
            canRead,
            status: "found",
          }
        : {
            suggestion: null,
            canRead,
            status: "empty",
          };
    } catch (error) {
      return {
        suggestion: null,
        canRead,
        status:
          error &&
          typeof error === "object" &&
          "name" in error &&
          typeof error.name === "string" &&
          ["NotAllowedError", "SecurityError"].includes(error.name)
            ? "blocked"
            : "empty",
      };
    }
  }

  return {
    suggestion: null,
    canRead,
    status: "unsupported",
  };
}
