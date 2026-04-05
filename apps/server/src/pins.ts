const VALID_PIN_TYPES = ["string", "url", "port", "code", "pr", "filename"] as const;

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
}
