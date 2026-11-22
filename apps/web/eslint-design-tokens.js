// Keeps class strings on the design tokens (tailwind.config.ts, src/index.css).
// Tailwind only sees classes written out in literals, so checking every string
// and template literal covers className, cn(), cva and class constants alike.

const COLOUR_UTILITY =
  "(?:bg|text|border(?:-[trblxyse])?|ring|ring-offset|fill|stroke|from|via|to|divide|outline|decoration|placeholder|accent|caret|shadow)";
const PALETTE =
  "(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)";
const CORNER = "(?:-(?:t|r|b|l|s|e|tl|tr|br|bl|ss|se|es|ee))?";

/** Tested against one class with its variants and `!` removed. */
export const CHECKS = [
  {
    id: "fontSize",
    test: new RegExp(
      "^text-(?:(?:xs|sm|base|lg|[2-9]?xl)(?:/.+)?|\\[(?:length:)?[\\d.]+(?:px|r?em|pt|%)\\](?:/.+)?)$"
    ),
    message:
      "Use a type-ramp step: text-label-xs/sm, text-body-sm/md/lg, text-heading-sm/md/lg or text-display.",
  },
  {
    id: "palette",
    test: new RegExp(
      `^${COLOUR_UTILITY}-(?:${PALETTE}-\\d{2,3}(?:/.+)?|\\[(?:#|rgba?\\(|hsla?\\(\\d).*)$`
    ),
    message:
      "Use a token colour: danger, warning, success, info, status-*, chart-* or a neutral.",
  },
  {
    id: "whiteBlack",
    test: new RegExp(`^${COLOUR_UTILITY}-(?:white|black)(?:/.+)?$`),
    message:
      "Use edge-*, fill-*, scrim, overlay or media tokens; white and black do not follow the theme.",
  },
  {
    id: "shadow",
    test: /^(?:(?:drop-)?shadow-\[|\[box-shadow:)/,
    message: "Use a shadow-elev-* token or a surface-* class.",
  },
  {
    id: "bareRounded",
    test: new RegExp(`^rounded${CORNER}$`),
    classListOnly: true,
    message: "Name the radius. Bare rounded is off the scale: use rounded-sm.",
  },
  {
    id: "radius",
    test: new RegExp(`^rounded${CORNER}-(?:[23]xl|\\[[\\d.]+(?:px|r?em)\\])$`),
    message:
      "Use a radius step: sm, md, lg, xl, full, or mark for chart marks.",
  },
  {
    id: "alpha",
    test: new RegExp(
      `^${COLOUR_UTILITY}-[a-z][a-z\\d-]*/(?:\\d+|\\[[\\d.]+%?\\])$`
    ),
    message:
      "Use a named alpha step (tint, tint-strong, line, line-strong, veil, soft, dense) or surface-subtle/hover/selected.",
  },
  {
    id: "zIndex",
    test: /^-?z-(?:[1-9]\d*|\[\d+\])$/,
    message: "Use a named z step from tailwind.config.ts, such as z-modal.",
  },
];

function baseOf(token) {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i += 1) {
    if (token[i] === "[") depth += 1;
    else if (token[i] === "]") depth -= 1;
    else if (token[i] === ":" && depth === 0) start = i + 1;
  }
  return token.slice(start).replace(/^!/, "");
}

const ONE_WORD_UTILITY =
  /^(?:absolute|block|border|fixed|flex|grid|hidden|inline|italic|relative|ring|shadow|sticky|truncate|underline|uppercase)$/;

// "rounded" is also an English word, so only a class list can trip that check.
function isClassList(tokens) {
  return (
    tokens.every((token) => /^[!a-z\d@[\]*&_-]/.test(token)) &&
    (tokens.length === 1 ||
      tokens.some(
        (token) => /[-:]/.test(token) || ONE_WORD_UTILITY.test(token)
      ))
  );
}

export function findViolations(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  const found = [];
  for (const token of tokens) {
    const base = baseOf(token);
    const check = CHECKS.find((candidate) => candidate.test.test(base));
    if (!check || (check.classListOnly && !isClassList(tokens))) continue;
    found.push({ token, id: check.id });
  }
  return found;
}

const designTokens = {
  meta: {
    type: "problem",
    docs: { description: "Require design tokens in class strings" },
    messages: Object.fromEntries(
      CHECKS.map(({ id, message }) => [id, `"{{token}}": ${message}`])
    ),
    schema: [
      {
        type: "object",
        properties: {
          // Exceptions name one file and one exact class.
          allow: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                token: { type: "string" },
              },
              required: ["file", "token"],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const filename = context.filename.replaceAll("\\", "/");
    const allowed = new Set(
      (context.options[0]?.allow ?? [])
        .filter(({ file }) => filename.endsWith(`/${file}`))
        .map(({ token }) => token)
    );
    const check = (node, text) => {
      for (const { token, id } of findViolations(text)) {
        if (allowed.has(token)) continue;
        context.report({ node, messageId: id, data: { token } });
      }
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};

export default { rules: { "design-tokens": designTokens } };
