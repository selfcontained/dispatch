import { getCssSelector } from "css-selector-generator";

import type {
  AncestorElementSummary,
  BrowserSelection,
  DomElementSummary,
  ElementContext,
  NearbyElementSummary,
} from "../types";

const MAX_TEXT_LENGTH = 2_000;
const MAX_HTML_LENGTH = 10_000;
const MAX_CLASSES = 20;
const MAX_CLASS_LENGTH = 128;
const MAX_SELECTOR_LENGTH = 4_096;
const MAX_XPATH_LENGTH = 4_096;
const MAX_ANCESTORS = 3;
const MAX_NEARBY_ELEMENTS = 4;
const MAX_SEARCH_HINTS = 8;
const MAX_SEARCH_HINT_LENGTH = 300;
const MAX_SUMMARY_SELECTOR_LENGTH = 512;
const MAX_SUMMARY_ID_LENGTH = 128;
const MAX_SUMMARY_CLASSES = 6;
const MAX_SUMMARY_CLASS_LENGTH = 64;
const MAX_SUMMARY_ACCESSIBLE_NAME_LENGTH = 200;
const MAX_SUMMARY_TEXT_LENGTH = 240;
const MAX_TEXT_NODES_VISITED = 500;
const SECRET_NAME_PART =
  /(?:^|[_-])(?:access[_-]?token|api[_-]?key|token|key|auth|authorization|password|passwd|secret|session|code|jwt|signature|sig)(?:$|[_-])/i;

function isSecretName(value: string): boolean {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Invalid percent escapes remain safe to compare in their original form.
  }
  const separatedCamelCase = decoded.replace(/([a-z0-9])([A-Z])/g, "$1-$2");
  return SECRET_NAME_PART.test(separatedCamelCase);
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1)}…`;
}

export function redactUrl(value: string): string {
  const hashIndex = value.indexOf("#");
  const hash = hashIndex >= 0 ? value.slice(hashIndex + 1) : "";
  const beforeHash = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const queryIndex = beforeHash.indexOf("?");
  const path = queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash;
  const query = queryIndex >= 0 ? beforeHash.slice(queryIndex + 1) : "";

  const redactParams = (input: string): { value: string; changed: boolean } => {
    const params = new URLSearchParams(input);
    let changed = false;
    for (const key of [...params.keys()]) {
      if (!isSecretName(key)) continue;
      params.set(key, "[redacted]");
      changed = true;
    }
    return { value: changed ? params.toString() : input, changed };
  };

  const redactedQuery = redactParams(query);
  let redactedHash = hash;
  const hashQueryIndex = hash.indexOf("?");
  if (hashQueryIndex >= 0) {
    const hashParams = redactParams(hash.slice(hashQueryIndex + 1));
    if (hashParams.changed) {
      redactedHash = `${hash.slice(0, hashQueryIndex + 1)}${hashParams.value}`;
    }
  } else if (hash.includes("=")) {
    redactedHash = redactParams(hash).value;
  }

  return `${path}${queryIndex >= 0 ? `?${redactedQuery.value}` : ""}${hashIndex >= 0 ? `#${redactedHash}` : ""}`;
}

const STABLE_ATTRIBUTE_SELECTOR =
  /^\[(?:data-testid|data-test|data-cy)(?:=|\])/i;
const STABLE_ATTRIBUTES = ["data-testid", "data-test", "data-cy"] as const;

function stableAttributeSelector(
  element: Element,
  root: ParentNode
): string | null {
  for (const attribute of STABLE_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (!value) continue;
    const escapedValue = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const selector = `[${attribute}='${escapedValue}']`;
    try {
      const matches = root.querySelectorAll(selector);
      if (matches.length === 1 && matches[0] === element) return selector;
    } catch {
      // Let the general generator produce a safe fallback.
    }
  }
  return null;
}

function fallbackSelector(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const parent = element.parentElement;
  if (!parent) return tag;
  const siblings = [...parent.children].filter(
    (sibling) => sibling.tagName === element.tagName
  );
  return siblings.length > 1
    ? `${tag}:nth-of-type(${siblings.indexOf(element) + 1})`
    : tag;
}

function boundedSelector(element: Element, maxLength: number): string {
  const selector = buildSelector(element);
  return selector.length <= maxLength ? selector : fallbackSelector(element);
}

function selectorWithinRoot(element: Element, root: ParentNode): string {
  const stableSelector = stableAttributeSelector(element, root);
  if (stableSelector) return stableSelector;

  try {
    return getCssSelector(element, {
      root,
      selectors: ["id", "attribute", "class", "tag", "nthoftype"],
      whitelist: [STABLE_ATTRIBUTE_SELECTOR],
      blacklist: [
        (selector) =>
          selector.startsWith("[") && !STABLE_ATTRIBUTE_SELECTOR.test(selector),
      ],
      ignoreGeneratedClassNames: true,
      maxCandidates: 128,
      maxCombinations: 64,
    });
  } catch {
    return fallbackSelector(element);
  }
}

export function buildSelector(element: Element): string {
  const root = element.getRootNode();
  const selectorRoot = root as ParentNode;
  const localSelector = selectorWithinRoot(element, selectorRoot);

  if (typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot) {
    // CSS selectors cannot cross a shadow boundary. Use the familiar `>>>`
    // separator to preserve a readable host-to-descendant path for the agent.
    return `${buildSelector(root.host)} >>> ${localSelector}`;
  }

  return localSelector;
}

function xpathLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat(${value
    .split("'")
    .map((part) => `'${part}'`)
    .join(', "\'", ')})`;
}

function uniqueAttributeXPath(
  element: Element,
  root: ParentNode
): string | null {
  for (const attribute of [...STABLE_ATTRIBUTES, "id"] as const) {
    const value = element.getAttribute(attribute);
    if (!value) continue;
    const matches = [...root.querySelectorAll(`[${attribute}]`)].filter(
      (candidate) => candidate.getAttribute(attribute) === value
    );
    if (matches.length === 1 && matches[0] === element) {
      return `//*[@${attribute}=${xpathLiteral(value)}]`;
    }
  }
  return null;
}

function absoluteXPathWithinRoot(element: Element): string {
  const segments: string[] = [];
  let current: Element | null = element;
  while (current) {
    const tagName = current.tagName.toLowerCase();
    const nodeTest =
      current.namespaceURI === "http://www.w3.org/1999/xhtml"
        ? tagName
        : `*[local-name()=${xpathLiteral(tagName)}]`;
    const currentTagName = current.tagName;
    const parent: Element | null = current.parentElement;
    const sameTagSiblings = parent
      ? [...parent.children].filter(
          (candidate) => candidate.tagName === currentTagName
        )
      : [current];
    segments.unshift(
      `${nodeTest}[${Math.max(1, sameTagSiblings.indexOf(current) + 1)}]`
    );
    current = parent;
  }
  return `/${segments.join("/")}`;
}

function xpathWithinRoot(element: Element, root: ParentNode): string {
  return (
    uniqueAttributeXPath(element, root) ?? absoluteXPathWithinRoot(element)
  );
}

/**
 * Build a readable XPath as a secondary locator. Like CSS, XPath cannot cross a
 * shadow boundary, so open shadow roots use the same explicit `>>>` separator.
 */
export function buildXPath(element: Element): string {
  const root = element.getRootNode();
  const localXPath = xpathWithinRoot(element, root as ParentNode);
  const result =
    typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot
      ? `${buildXPath(root.host)} >>> ${localXPath}`
      : localXPath;
  return result.length <= MAX_XPATH_LENGTH
    ? result
    : absoluteXPathWithinRoot(element).slice(0, MAX_XPATH_LENGTH);
}

function isInsideEditable(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    const contentEditable = current.getAttribute("contenteditable");
    if (contentEditable !== null) {
      return contentEditable.toLowerCase() !== "false";
    }
    current = current.parentElement;
  }
  return false;
}

export function sanitizeElement(element: Element): Element {
  const clone = element.cloneNode(true) as Element;

  if (isInsideEditable(element)) {
    clone.replaceChildren("[editable content omitted]");
  }

  if (clone.matches("script, style, noscript, template")) {
    clone.replaceChildren();
  }

  clone
    .querySelectorAll("script, style, noscript, template")
    .forEach((node) => {
      node.remove();
    });

  const formControls = [
    clone,
    ...clone.querySelectorAll("input, textarea, select, option"),
  ];
  for (const control of formControls) {
    if (!control.matches("input, textarea, select, option")) continue;
    control.removeAttribute("value");
    control.removeAttribute("checked");
    control.removeAttribute("selected");
    if (control.matches("textarea")) control.textContent = "";
  }

  clone.querySelectorAll("[contenteditable]").forEach((node) => {
    node.textContent = "[editable content omitted]";
  });

  for (const node of [clone, ...clone.querySelectorAll("*")]) {
    node.removeAttribute("srcdoc");
    node.removeAttribute("srcset");
    node.removeAttribute("ping");
    node.removeAttribute("style");
    for (const attributeName of [
      "href",
      "src",
      "action",
      "formaction",
      "poster",
      "cite",
      "background",
      "xlink:href",
    ]) {
      const value = node.getAttribute(attributeName);
      if (!value) continue;
      if (/^(?:data|blob):/i.test(value.trim())) {
        node.removeAttribute(attributeName);
      } else {
        node.setAttribute(attributeName, redactUrl(value));
      }
    }
    for (const attribute of [...node.attributes]) {
      const attributeName = attribute.name.toLowerCase();
      if (attributeName.startsWith("on") || isSecretName(attributeName)) {
        node.removeAttribute(attribute.name);
      }
    }
  }

  return clone;
}

function safeText(element: Element, maxLength: number): string {
  if (
    element.matches(
      "html, body, input, textarea, select, option, script, style, noscript, template"
    ) ||
    isInsideEditable(element)
  )
    return "";

  const chunks: string[] = [];
  const stack: Node[] = [element];
  let visited = 0;
  let collectedLength = 0;
  while (
    stack.length > 0 &&
    visited < MAX_TEXT_NODES_VISITED &&
    collectedLength < maxLength
  ) {
    const node = stack.pop();
    if (!node) break;
    visited += 1;

    if (node.nodeType === Node.TEXT_NODE) {
      const remaining = maxLength - collectedLength;
      const value = (node.textContent ?? "").slice(0, remaining);
      chunks.push(value);
      collectedLength += value.length;
      continue;
    }

    if (
      node instanceof Element &&
      node !== element &&
      (node.matches(
        "input, textarea, select, option, script, style, noscript, template"
      ) ||
        isInsideEditable(node))
    ) {
      continue;
    }

    const children = [...node.childNodes];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }

  return truncate(chunks.join(" "), maxLength);
}

function accessibleName(element: Element, maxLength: number): string | null {
  if (isInsideEditable(element)) return null;

  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) return truncate(ariaLabel, maxLength) || null;

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const labelledText = labelledBy
      .split(/\s+/)
      .map((id) => {
        const label = element.ownerDocument.getElementById(id);
        return label ? safeText(label, maxLength) : "";
      })
      .join(" ");
    const normalized = truncate(labelledText, maxLength);
    if (normalized) return normalized;
  }

  for (const attributeName of ["alt", "title"] as const) {
    const value = element.getAttribute(attributeName);
    if (value) return truncate(value, maxLength) || null;
  }

  const id = element.getAttribute("id");
  if (id) {
    const explicitLabel = [
      ...element.ownerDocument.querySelectorAll("label"),
    ].find((label) => label.getAttribute("for") === id);
    if (explicitLabel) {
      const labelText = safeText(explicitLabel, maxLength);
      if (labelText) return labelText;
    }
  }
  const wrappingLabel = element.closest("label");
  if (wrappingLabel) {
    const labelText = safeText(wrappingLabel, maxLength);
    if (labelText) return labelText;
  }

  if (element.matches("button, a, summary")) {
    return safeText(element, maxLength) || null;
  }
  return null;
}

function summarizeElement(element: Element): DomElementSummary {
  return {
    tagName: element.tagName.toLowerCase(),
    selector: boundedSelector(element, MAX_SUMMARY_SELECTOR_LENGTH),
    id:
      truncate(element.getAttribute("id") ?? "", MAX_SUMMARY_ID_LENGTH) || null,
    classes: [...element.classList]
      .slice(0, MAX_SUMMARY_CLASSES)
      .map((className) => truncate(className, MAX_SUMMARY_CLASS_LENGTH)),
    role: truncate(element.getAttribute("role") ?? "", 128) || null,
    accessibleName: accessibleName(element, MAX_SUMMARY_ACCESSIBLE_NAME_LENGTH),
    text: safeText(element, MAX_SUMMARY_TEXT_LENGTH),
  };
}

function collectAncestors(element: Element): AncestorElementSummary[] {
  const ancestors: AncestorElementSummary[] = [];
  let current = element.parentElement;
  let depth = 1;
  while (current && ancestors.length < MAX_ANCESTORS) {
    ancestors.push({ ...summarizeElement(current), depth });
    current = current.parentElement;
    depth += 1;
  }
  return ancestors;
}

function collectNearbyElements(element: Element): NearbyElementSummary[] {
  const nearby: NearbyElementSummary[] = [];
  const seen = new Set<Element>();
  let relativeTo: Element | null = element;
  let relativeToDepth = 0;

  while (relativeTo && nearby.length < MAX_NEARBY_ELEMENTS) {
    const candidates = [
      ["previous-sibling", relativeTo.previousElementSibling],
      ["next-sibling", relativeTo.nextElementSibling],
    ] as const;
    for (const [relation, candidate] of candidates) {
      if (
        !candidate ||
        seen.has(candidate) ||
        candidate.matches("script, style, noscript, template")
      )
        continue;
      nearby.push({
        ...summarizeElement(candidate),
        relation,
        relativeToDepth,
      });
      seen.add(candidate);
      if (nearby.length >= MAX_NEARBY_ELEMENTS) break;
    }
    relativeTo = relativeTo.parentElement;
    relativeToDepth += 1;
    if (relativeToDepth > MAX_ANCESTORS) break;
  }
  return nearby;
}

function quoteHint(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function collectSearchHints(
  element: Element,
  ancestors: AncestorElementSummary[],
  nearbyElements: NearbyElementSummary[]
): string[] {
  const hints: string[] = [];
  const seen = new Set<string>();
  const add = (hint: string) => {
    const bounded = truncate(hint, MAX_SEARCH_HINT_LENGTH);
    if (!bounded || seen.has(bounded) || hints.length >= MAX_SEARCH_HINTS)
      return;
    seen.add(bounded);
    hints.push(bounded);
  };

  for (const attribute of STABLE_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (value) add(`${attribute}="${quoteHint(value)}"`);
  }
  const id = element.getAttribute("id");
  if (id) add(`id="${quoteHint(id)}"`);
  for (const attribute of ["aria-label", "title", "alt"] as const) {
    const value = element.getAttribute(attribute);
    if (value) add(`${attribute}="${quoteHint(value)}"`);
  }

  const selectedText = safeText(element, 160);
  if (selectedText) add(`"${quoteHint(selectedText)}"`);
  const selectedClasses = [...element.classList]
    .filter(Boolean)
    .slice(0, 4)
    .map((className) => truncate(className, MAX_SUMMARY_CLASS_LENGTH))
    .join(" ");
  if (selectedClasses) add(`class="${quoteHint(selectedClasses)}"`);

  let ancestorElement = element.parentElement;
  for (const summary of ancestors) {
    if (ancestorElement) {
      for (const attribute of STABLE_ATTRIBUTES) {
        const value = ancestorElement.getAttribute(attribute);
        if (value) add(`${attribute}="${quoteHint(value)}"`);
      }
      ancestorElement = ancestorElement.parentElement;
    }
    if (summary.id) add(`id="${quoteHint(summary.id)}"`);
    if (summary.accessibleName) add(`"${quoteHint(summary.accessibleName)}"`);
  }
  for (const summary of nearbyElements) {
    if (summary.accessibleName) add(`"${quoteHint(summary.accessibleName)}"`);
    else if (summary.text) add(`"${quoteHint(summary.text)}"`);
  }
  return hints;
}

export function createElementContext(element: Element): ElementContext {
  const sanitized = sanitizeElement(element);
  const rect = element.getBoundingClientRect();
  const ancestors = collectAncestors(element);
  const nearbyElements = collectNearbyElements(element);

  return {
    tagName: element.tagName.toLowerCase(),
    selector: boundedSelector(element, MAX_SELECTOR_LENGTH),
    xpath: buildXPath(element),
    id: truncate(element.getAttribute("id") ?? "", 512) || null,
    classes: [...element.classList]
      .slice(0, MAX_CLASSES)
      .map((className) => truncate(className, MAX_CLASS_LENGTH)),
    role: truncate(element.getAttribute("role") ?? "", 256) || null,
    accessibleName: accessibleName(element, 500),
    text: safeText(element, MAX_TEXT_LENGTH),
    outerHtml: truncate(sanitized.outerHTML, MAX_HTML_LENGTH),
    ancestors,
    nearbyElements,
    searchHints: collectSearchHints(element, ancestors, nearbyElements),
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

export function createBrowserSelection(element: Element): BrowserSelection {
  return {
    page: {
      url: redactUrl(window.location.href),
      title: document.title,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      devicePixelRatio: window.devicePixelRatio,
    },
    element: createElementContext(element),
  };
}
