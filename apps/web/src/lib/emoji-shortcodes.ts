/** Local, curated Slack/GitHub-compatible aliases; no runtime lookup or custom emoji.
 * Coverage intentionally focuses on common faces, reactions, symbols and gestures.
 * Aliases are case-sensitive. Extend this table to add supported names.
 */
export const emojiShortcodes: Readonly<Record<string, string>> = {
  smile: "😄",
  smiley: "😃",
  smiling_face: "☺️",
  grinning: "😀",
  grin: "😁",
  joy: "😂",
  rofl: "🤣",
  sweat_smile: "😅",
  wink: "😉",
  blush: "😊",
  heart_eyes: "😍",
  kissing_heart: "😘",
  thinking_face: "🤔",
  sunglasses: "😎",
  neutral_face: "😐",
  expressionless: "😑",
  confused: "😕",
  cry: "😢",
  sob: "😭",
  angry: "😠",
  rage: "😡",
  scream: "😱",
  sleepy: "😪",
  sleeping: "😴",
  eyes: "👀",
  tada: "🎉",
  rocket: "🚀",
  heart: "❤️",
  broken_heart: "💔",
  blue_heart: "💙",
  green_heart: "💚",
  yellow_heart: "💛",
  purple_heart: "💜",
  fire: "🔥",
  star: "⭐",
  sparkles: "✨",
  warning: "⚠️",
  white_check_mark: "✅",
  x: "❌",
  thumbs_up: "👍",
  thumbsup: "👍",
  "+1": "👍",
  "thumbs-up": "👍",
  thumbs_down: "👎",
  thumbsdown: "👎",
  "-1": "👎",
  wave: "👋",
  clap: "👏",
  raised_hands: "🙌",
  pray: "🙏",
  muscle: "💪",
  ok_hand: "👌",
  point_up: "☝️",
  handshake: "🤝",
  hundred: "💯",
  "100": "💯",
};

export function emojiQueryAt(text: string, caret: number) {
  const before = text.slice(0, caret);
  const match = /(?:^|[\s([{])(:([a-z0-9_+-]+))$/.exec(before);
  if (!match) return null;
  const start = caret - match[1]!.length;
  // Backtick spans and fences are literal examples. Track matching run lengths
  // so a single backtick inside a fenced example cannot accidentally end it.
  let delimiter = 0;
  for (const run of text.slice(0, start).matchAll(/`+|~{3,}/g)) {
    const length = run[0].length;
    if (!delimiter) delimiter = run[0][0] === "~" ? -length : length;
    else if (delimiter === (run[0][0] === "~" ? -length : length))
      delimiter = 0;
  }
  if (delimiter) return null;
  return { start, query: match[2]! };
}

export function matchEmoji(query: string) {
  return Object.entries(emojiShortcodes)
    .filter(([alias]) => alias.startsWith(query))
    .sort(([a], [b]) => Number(b === query) - Number(a === query))
    .slice(0, 8);
}

export function emojiForAlias(alias: string): string | undefined {
  const value = Object.prototype.hasOwnProperty.call(emojiShortcodes, alias)
    ? emojiShortcodes[alias]
    : undefined;
  return typeof value === "string" ? value : undefined;
}
