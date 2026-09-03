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
