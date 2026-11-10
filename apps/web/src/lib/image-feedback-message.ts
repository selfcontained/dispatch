/** The explicit recipient owns routing; note text and filenames are literal content.
 * Keep the untouched originals in the JSON attachment. A zero-width separator
 * leaves @ text readable while preventing the chat API from routing mentions.
 */
export function imageFeedbackMessage(
  note: string,
  fileName: string,
  number: number
): string {
  return `${note.trim()}\n\nFeedback on ${fileName} · Callout ${number}`.replace(
    /@/g,
    "@\u200b"
  );
}
