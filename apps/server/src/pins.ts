const VALID_PIN_TYPES = ["string", "url", "port", "code", "pr", "filename", "markdown"] as const;
const MAX_MARKDOWN_LENGTH = 2000;
const MAX_MARKDOWN_CODE_BLOCK_LINES = 20;

function stripFencedCodeBlocks(value: string): { sanitized: string; codeBlocks: string[] } {
  const codeBlocks: string[] = [];
  const sanitized = value.replace(/```[^\n]*\n([\s\S]*?)```/g, (_match, body: string) => {
    codeBlocks.push(body);
    return "";
  });
  return { sanitized, codeBlocks };
}

function validateMarkdownPinValue(value: string): void {
  if (value.length > MAX_MARKDOWN_LENGTH) {
    throw new Error(`Markdown pins must be ${MAX_MARKDOWN_LENGTH} characters or fewer.`);
  }

  const { sanitized, codeBlocks } = stripFencedCodeBlocks(value);

  for (const block of codeBlocks) {
    const lineCount = block.replace(/\n$/, "").split("\n").length;
    if (lineCount > MAX_MARKDOWN_CODE_BLOCK_LINES) {
      throw new Error(`Markdown pin code blocks must be ${MAX_MARKDOWN_CODE_BLOCK_LINES} lines or fewer.`);
    }
  }

  const disallowedPatterns: Array<[RegExp, string]> = [
    [/!\[[^\]]*]\((?:[^()\\]|\\.)+\)/, "Markdown pins do not support images."],
    [/\[[^\]]+]\((?:[^()\\]|\\.)+\)/, "Markdown pins do not support links."],
    [/\[[^\]]+]\[[^\]]*]/, "Markdown pins do not support reference-style links."],
    [/^\s*\[[^\]]+]:\s*\S+/m, "Markdown pins do not support reference-style links."],
    [/<\/?[A-Za-z][^>]*>/, "Markdown pins do not support raw HTML."],
    [/^\s{0,3}#{1,6}\s/m, "Markdown pins do not support headings."],
    [/^\s{0,3}>\s/m, "Markdown pins do not support blockquotes."],
    [/^\s{0,3}\d+\.\s/m, "Markdown pins only support flat bullet lists."],
    [/^(?: {2,}|\t+)[-*+]\s/m, "Markdown pins do not support nested lists."],
    [/^(?: {2,}|\t+)\d+\.\s/m, "Markdown pins do not support nested lists."],
    [/^\s*\|.+\|\s*$/m, "Markdown pins do not support tables."],
    [/^\s*\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+\s*\|?\s*$/m, "Markdown pins do not support tables."],
  ];

  for (const [pattern, message] of disallowedPatterns) {
    if (pattern.test(sanitized)) {
      throw new Error(message);
    }
  }
}

export type PinType = (typeof VALID_PIN_TYPES)[number];

export function isPinType(value: string): value is PinType {
  return VALID_PIN_TYPES.includes(value as PinType);
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
    const parts = value.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean);
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
}
