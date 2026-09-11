import * as z from "zod/v4";

/**
 * Upper bound for a link/PR attachment URL. Long enough for signed or
 * query-heavy links, short enough that a URL can't smuggle a body-sized
 * payload past the message budget into the pane envelope.
 */
export const CHAT_URL_MAX_CHARS = 2048;

/**
 * A web URL an attachment may carry: absolute, http(s) only, bounded length.
 * Shared by the user route and the agent MCP tools so both paths agree.
 * Non-web schemes (javascript:, data:, file:) are rejected because the value
 * is persisted, printed into the agent's terminal, and rendered as an anchor.
 */
export const chatUrlSchema = z
  .string()
  .trim()
  .min(1, "url is required.")
  .max(
    CHAT_URL_MAX_CHARS,
    `url must be ${CHAT_URL_MAX_CHARS} characters or fewer.`
  )
  .refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "url must be an absolute http or https URL.");

/**
 * Longest emoji a reaction may carry, in UTF-16 units. ZWJ family sequences
 * with skin tones run to about 25; anything past this is not one emoji.
 */
export const CHAT_REACTION_EMOJI_MAX_CHARS = 32;

/** Every code point an emoji sequence may be built from. */
const EMOJI_SEQUENCE_RE =
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|⃣)+$/u;

/**
 * What makes it an emoji rather than a run of components: a pictograph, a
 * flag's regional indicator, or a keycap. Without it, digits, `#` and `*`
 * (all emoji components) would pass on their own.
 */
const EMOJI_BASE_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

/**
 * The reaction emoji as stored, or null when the value is not one emoji
 * sequence. The emoji is printed into the agent's pane inside the reaction
 * envelope, so this is also what keeps a reaction from carrying text.
 */
export function normalizeReactionEmoji(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const emoji = value.trim();
  if (emoji.length === 0 || emoji.length > CHAT_REACTION_EMOJI_MAX_CHARS) {
    return null;
  }
  if (!EMOJI_SEQUENCE_RE.test(emoji) || !EMOJI_BASE_RE.test(emoji)) {
    return null;
  }
  return emoji;
}
