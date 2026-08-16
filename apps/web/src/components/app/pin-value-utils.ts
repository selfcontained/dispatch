import { type AgentPin } from "@/components/app/types";

const SAFE_URL_RE = /^https?:\/\//i;
const GH_PR_RE = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i;

/** Turn a GitHub PR URL into "owner/repo#123"; fall back to the raw value. */
export function formatPrDisplay(value: string): string {
  const m = GH_PR_RE.exec(value);
  return m ? `${m[1]}#${m[2]}` : value;
}

export type ResolvedValue = {
  display: string;
  tooltip: string;
  href: string | null;
  badge: boolean;
  icon: "pr" | "file" | null;
};

export function trimFilenameForDisplay(
  value: string,
  workspaceRoot: string | null
): { display: string; tooltip: string } {
  if (!workspaceRoot) {
    return { display: value, tooltip: value };
  }

  const normalizedRoot = workspaceRoot.endsWith("/")
    ? workspaceRoot.slice(0, -1)
    : workspaceRoot;
  if (!normalizedRoot) {
    return { display: value, tooltip: value };
  }

  if (value === normalizedRoot) {
    return { display: "./", tooltip: value };
  }

  const prefix = `${normalizedRoot}/`;
  return value.startsWith(prefix)
    ? { display: value.slice(prefix.length), tooltip: value }
    : { display: value, tooltip: value };
}

export function shouldRenderMarkdownAsPlainText(value: string): boolean {
  const sanitized = value.replace(/```[^\n]*\n[\s\S]*?```/g, "");
  const unsupportedPatterns = [
    /!\[[^\]]*]\((?:[^()\\]|\\.)+\)/,
    /\[[^\]]+]\((?:[^()\\]|\\.)+\)/,
    /\[[^\]]+]\[[^\]]*]/,
    /^\s*\[[^\]]+]:\s*\S+/m,
    /<\/?[A-Za-z][^>]*>/,
    /^\s{0,3}#{1,6}\s/m,
    /^\s{0,3}>\s/m,
    /^\s{0,3}\d+\.\s/m,
    /^(?: {2,}|\t+)[-*+]\s/m,
    /^(?: {2,}|\t+)\d+\.\s/m,
  ];
  return unsupportedPatterns.some((pattern) => pattern.test(sanitized));
}

export function normalizeExternalHref(
  type: AgentPin["type"],
  value: string
): string | null {
  if (type !== "url" && type !== "pr") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const candidate = SAFE_URL_RE.test(trimmed)
    ? trimmed
    : type === "url"
      ? `http://${trimmed}`
      : trimmed;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    return null;
  }

  return null;
}

export function resolveDisplayValue(
  type: AgentPin["type"],
  value: string
): ResolvedValue {
  const href = normalizeExternalHref(type, value);
  if (type === "pr" && href) {
    return {
      display: formatPrDisplay(href),
      tooltip: value.trim(),
      href,
      badge: false,
      icon: "pr",
    };
  }
  if (type === "pr") {
    return {
      display: value,
      tooltip: value,
      href: null,
      badge: false,
      icon: "pr",
    };
  }
  if (type === "url" && href) {
    return {
      display: value.trim(),
      tooltip: value.trim(),
      href,
      badge: false,
      icon: null,
    };
  }
  if (type === "url") {
    return {
      display: value,
      tooltip: value,
      href: null,
      badge: false,
      icon: null,
    };
  }
  if (type === "filename") {
    return {
      display: value,
      tooltip: value,
      href: null,
      badge: true,
      icon: "file",
    };
  }
  if (type === "port" || type === "code") {
    return {
      display: value,
      tooltip: value,
      href: null,
      badge: true,
      icon: null,
    };
  }
  return {
    display: value,
    tooltip: value,
    href: null,
    badge: false,
    icon: null,
  };
}
