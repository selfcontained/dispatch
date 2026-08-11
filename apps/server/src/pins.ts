const VALID_PIN_TYPES = [
  "string",
  "url",
  "port",
  "code",
  "pr",
  "filename",
  "markdown",
  "shortcut",
] as const;
const VALID_PIN_SHORTCUT_VARIANTS = [
  "default",
  "primary",
  "destructive",
] as const;
/**
 * Icons a shortcut pin may use. Mirrored by the web icon map
 * (apps/web/src/lib/pin-shortcut-icons.ts); a guard test asserts the two stay
 * in lockstep, since a drifted name silently renders as the fallback.
 */
export const VALID_PIN_SHORTCUT_ICONS = [
  "zap",
  "play",
  "rocket",
  "refresh",
  "check",
  "x",
  "pause",
  "trash",
  "bug",
  "search",
  "database",
  "terminal",
  "file",
  "branch",
  "pull-request",
  "message",
  "flag",
  "clock",
  "checklist",
  "sparkles",
  "wrench",
  "shield",
  "upload",
  "download",
  "arrow",
] as const;
const MAX_SHORTCUT_PROMPT_LENGTH = 2000;
// A caption is a subtitle, not a body: three clamped lines in a ~400px rail is
// roughly 165 visible characters, and markdown markup spends from the same
// budget. Well short of the 2000 a markdown pin gets, deliberately.
const MAX_PIN_CAPTION_LENGTH = 200;
const MAX_MARKDOWN_LENGTH = 2000;
const MAX_MARKDOWN_CODE_BLOCK_LINES = 20;

function stripFencedCodeBlocks(value: string): {
  sanitized: string;
  codeBlocks: string[];
} {
  const codeBlocks: string[] = [];
  const sanitized = value.replace(
    /```[^\n]*\n([\s\S]*?)```/g,
    (_match, body: string) => {
      codeBlocks.push(body);
      return "";
    }
  );
  return { sanitized, codeBlocks };
}

function validateMarkdownPinValue(value: string): void {
  if (value.length > MAX_MARKDOWN_LENGTH) {
    throw new Error(
      `Markdown pins must be ${MAX_MARKDOWN_LENGTH} characters or fewer.`
    );
  }

  const { sanitized, codeBlocks } = stripFencedCodeBlocks(value);

  for (const block of codeBlocks) {
    const lineCount = block.replace(/\n$/, "").split("\n").length;
    if (lineCount > MAX_MARKDOWN_CODE_BLOCK_LINES) {
      throw new Error(
        `Markdown pin code blocks must be ${MAX_MARKDOWN_CODE_BLOCK_LINES} lines or fewer.`
      );
    }
  }

  const disallowedPatterns: Array<[RegExp, string]> = [
    [/!\[[^\]]*]\((?:[^()\\]|\\.)+\)/, "Markdown pins do not support images."],
    [/\[[^\]]+]\((?:[^()\\]|\\.)+\)/, "Markdown pins do not support links."],
    [
      /\[[^\]]+]\[[^\]]*]/,
      "Markdown pins do not support reference-style links.",
    ],
    [
      /^\s*\[[^\]]+]:\s*\S+/m,
      "Markdown pins do not support reference-style links.",
    ],
    [/<\/?[A-Za-z][^>]*>/, "Markdown pins do not support raw HTML."],
    [/^\s{0,3}#{1,6}\s/m, "Markdown pins do not support headings."],
    [/^\s{0,3}>\s/m, "Markdown pins do not support blockquotes."],
    [/^\s{0,3}\d+\.\s/m, "Markdown pins only support flat bullet lists."],
    [/^(?: {2,}|\t+)[-*+]\s/m, "Markdown pins do not support nested lists."],
    [/^(?: {2,}|\t+)\d+\.\s/m, "Markdown pins do not support nested lists."],
    [/^\s*\|.+\|\s*$/m, "Markdown pins do not support tables."],
    [
      /^\s*\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+\s*\|?\s*$/m,
      "Markdown pins do not support tables.",
    ],
  ];

  for (const [pattern, message] of disallowedPatterns) {
    if (pattern.test(sanitized)) {
      throw new Error(message);
    }
  }
}

export type PinType = (typeof VALID_PIN_TYPES)[number];
export type PinShortcutVariant = (typeof VALID_PIN_SHORTCUT_VARIANTS)[number];
export type PinShortcutIcon = (typeof VALID_PIN_SHORTCUT_ICONS)[number];

export function isPinType(value: string): value is PinType {
  return VALID_PIN_TYPES.includes(value as PinType);
}

export function isPinShortcutVariant(
  value: string
): value is PinShortcutVariant {
  return VALID_PIN_SHORTCUT_VARIANTS.includes(value as PinShortcutVariant);
}

export function isPinShortcutIcon(value: string): value is PinShortcutIcon {
  return VALID_PIN_SHORTCUT_ICONS.includes(value as PinShortcutIcon);
}

/**
 * The caption rendered under any pin. Inline markdown only (enforced at
 * render), single line of source, and short enough to stay a subtitle.
 */
export function validatePinCaption(caption: string): void {
  if (caption.length > MAX_PIN_CAPTION_LENGTH) {
    throw new Error(
      `Pin captions must be ${MAX_PIN_CAPTION_LENGTH} characters or fewer.`
    );
  }
  if (/[\r\n]/.test(caption)) {
    throw new Error("Pin captions must be a single line.");
  }
}

/** Button styling and icon for a shortcut pin. */
export function validatePinShortcutFields(pin: {
  variant?: string;
  icon?: string;
}): void {
  if (pin.variant !== undefined && !isPinShortcutVariant(pin.variant)) {
    throw new Error(
      `Shortcut pin variant must be one of: ${VALID_PIN_SHORTCUT_VARIANTS.join(", ")}.`
    );
  }

  if (pin.icon !== undefined && !isPinShortcutIcon(pin.icon)) {
    throw new Error(
      `Shortcut pin icon must be one of: ${VALID_PIN_SHORTCUT_ICONS.join(", ")}.`
    );
  }
}

export function validatePinValue(type: PinType, value: string): void {
  if (type === "url") {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("URL pins must use http or https.");
      }
    } catch {
      throw new Error("URL pins must be valid http or https URLs.");
    }
  }

  if (type === "port") {
    const parts = value
      .split(/[\s,]+/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 0) {
      throw new Error("Port pins must include at least one integer.");
    }

    for (const part of parts) {
      if (!/^\d+$/.test(part)) {
        throw new Error("Port pins must be integers.");
      }

      const port = Number.parseInt(part, 10);
      if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
        throw new Error("Port pins must be integers between 0 and 65535.");
      }
    }
  }

  if (type === "markdown") {
    validateMarkdownPinValue(value);
  }

  if (type === "shortcut") {
    if (!value.trim()) {
      throw new Error("Shortcut pins must carry a non-empty prompt.");
    }
    if (value.length > MAX_SHORTCUT_PROMPT_LENGTH) {
      throw new Error(
        `Shortcut prompts must be ${MAX_SHORTCUT_PROMPT_LENGTH} characters or fewer.`
      );
    }
  }
}
