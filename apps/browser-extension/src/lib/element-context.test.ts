// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildSelector,
  buildXPath,
  createElementContext,
  redactUrl,
  sanitizeElement,
} from "./element-context";

describe("buildSelector", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("prefers a unique id", () => {
    document.body.innerHTML =
      '<main><button id="save-button">Save</button></main>';
    const button = document.querySelector("button");
    expect(button).not.toBeNull();
    expect(buildSelector(button as Element)).toBe("#save-button");
  });

  it("prefers stable test attributes and disambiguates siblings", () => {
    document.body.innerHTML = `
      <main>
        <section data-testid="summary">Summary</section>
        <div class="cards"><article>One</article><article>Two</article></div>
      </main>`;
    expect(buildSelector(document.querySelector("section") as Element)).toBe(
      "[data-testid='summary']"
    );
    expect(buildSelector(document.querySelectorAll("article")[1])).toContain(
      "article:nth-of-type(2)"
    );
  });

  it("ignores generated class names and sensitive attributes", () => {
    document.body.innerHTML = `
      <main>
        <a class="primary-button css-a7H92x" href="/account?token=secret">
          Account
        </a>
      </main>`;
    const selector = buildSelector(document.querySelector("a") as Element);

    expect(selector).toContain(".primary-button");
    expect(selector).not.toContain("css-a7H92x");
    expect(selector).not.toContain("href");
    expect(selector).not.toContain("secret");
  });

  it("describes selectors across open shadow roots", () => {
    const host = document.createElement("user-card");
    host.id = "account-card";
    document.body.append(host);
    const shadowRoot = host.attachShadow({ mode: "open" });
    shadowRoot.innerHTML = '<button data-testid="save-profile">Save</button>';
    const button = shadowRoot.querySelector("button") as Element;

    expect(buildSelector(button)).toBe(
      "#account-card >>> [data-testid='save-profile']"
    );
  });
});

describe("buildXPath", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("prefers stable unique attributes, then a unique id", () => {
    document.body.innerHTML = `
      <main>
        <button data-testid="save-profile">Save</button>
        <button id="cancel-profile">Cancel</button>
      </main>`;

    expect(buildXPath(document.querySelector("[data-testid]") as Element)).toBe(
      "//*[@data-testid='save-profile']"
    );
    expect(
      buildXPath(document.querySelector("#cancel-profile") as Element)
    ).toBe("//*[@id='cancel-profile']");
  });

  it("uses a positional absolute path when stable attributes are unavailable", () => {
    document.body.innerHTML =
      "<main><article>One</article><article><span>Two</span></article></main>";
    expect(buildXPath(document.querySelector("span") as Element)).toBe(
      "/html[1]/body[1]/main[1]/article[2]/span[1]"
    );
  });

  it("quotes attribute values safely", () => {
    document.body.innerHTML = `<button data-testid="owner's &quot;save&quot;">Save</button>`;
    expect(buildXPath(document.querySelector("button") as Element)).toBe(
      `//*[@data-testid=concat('owner', "'", 's "save"')]`
    );
  });

  it("uses namespace-safe node tests for SVG elements", () => {
    document.body.innerHTML = `<main><svg><g><path></path></g></svg></main>`;

    expect(buildXPath(document.querySelector("path") as Element)).toContain(
      "*[local-name()='svg'][1]/*[local-name()='g'][1]/*[local-name()='path'][1]"
    );
  });
});

describe("enriched element context", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("captures three bounded nearest-ancestor summaries for a leaf", () => {
    document.body.innerHTML = `
      <main id="dashboard">
        <section class="status-card" aria-label="Runtime status">
          <div class="badge rounded"><span id="state">Sandboxed</span></div>
        </section>
      </main>`;

    const context = createElementContext(
      document.querySelector("#state") as Element
    );

    expect(context.ancestors).toHaveLength(3);
    expect(
      context.ancestors.map(({ tagName, depth }) => ({ tagName, depth }))
    ).toEqual([
      { tagName: "div", depth: 1 },
      { tagName: "section", depth: 2 },
      { tagName: "main", depth: 3 },
    ]);
    expect(context.ancestors[0]).toMatchObject({
      classes: ["badge", "rounded"],
      text: "Sandboxed",
    });
    expect(context.ancestors[1]).toMatchObject({
      accessibleName: "Runtime status",
      text: "Sandboxed",
    });
    expect(context.ancestors[0]).not.toHaveProperty("outerHtml");
  });

  it("finds sibling text next to a deeply selected icon", () => {
    document.body.innerHTML = `
      <button aria-label="Open settings" data-cy="settings-button">
        <svg class="gear" aria-hidden="true"><path id="tooth"></path></svg>
        <span>Settings</span>
      </button>`;

    const context = createElementContext(
      document.querySelector("path") as Element
    );

    expect(context.nearbyElements).toContainEqual(
      expect.objectContaining({
        tagName: "span",
        relation: "next-sibling",
        relativeToDepth: 1,
        text: "Settings",
      })
    );
    expect(context.searchHints).toContain('data-cy="settings-button"');
    expect(context.searchHints).toContain('"Settings"');
  });

  it("ranks stable DOM-derived hints and deduplicates them", () => {
    document.body.innerHTML = `
      <section id="account-card" aria-label="Account">
        <button data-testid="save-profile" id="save" class="primary wide"
          aria-label="Save profile" title="Save profile">Save</button>
      </section>`;

    const context = createElementContext(
      document.querySelector("button") as Element
    );

    expect(context.searchHints.slice(0, 5)).toEqual([
      'data-testid="save-profile"',
      'id="save"',
      'aria-label="Save profile"',
      'title="Save profile"',
      '"Save"',
    ]);
    expect(context.searchHints).toContain('class="primary wide"');
    expect(new Set(context.searchHints).size).toBe(context.searchHints.length);
  });

  it("strictly limits ancestors, nearby elements, hints, and summary fields", () => {
    document.body.innerHTML = `
      <main><section><article><div id="siblings">
        <i aria-label="one"></i><i aria-label="two"></i>
        <button id="target" class="${Array.from(
          { length: 12 },
          (_, index) => `class-${index}-${"x".repeat(100)}`
        ).join(" ")}" aria-label="${"label ".repeat(100)}">Target</button>
        <i aria-label="three"></i><i aria-label="four"></i>
      </div></article></section></main>`;
    const context = createElementContext(
      document.querySelector("#target") as Element
    );

    expect(context.ancestors).toHaveLength(3);
    expect(context.nearbyElements.length).toBeLessThanOrEqual(4);
    expect(context.searchHints.length).toBeLessThanOrEqual(8);
    for (const summary of [...context.ancestors, ...context.nearbyElements]) {
      expect(summary.selector.length).toBeLessThanOrEqual(512);
      expect(summary.classes.length).toBeLessThanOrEqual(6);
      expect(summary.classes.every((value) => value.length <= 64)).toBe(true);
      expect(summary.text.length).toBeLessThanOrEqual(240);
      expect(summary.accessibleName?.length ?? 0).toBeLessThanOrEqual(200);
    }
  });
});

describe("element context privacy", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("removes form values, editable content, scripts, and event handlers", () => {
    document.body.innerHTML = `
      <section aria-label="Account form" onclick="steal()">
        <input value="secret" checked>
        <textarea>private note</textarea>
        <div contenteditable="true">draft password</div>
        <a href="/account?session=abc&view=profile">Profile</a>
        <iframe srcdoc="<p>sensitive</p>" src="/frame?auth_token=xyz"></iframe>
        <script>window.privateData = true</script>
        <p>Visible description</p>
      </section>`;
    const section = document.querySelector("section") as Element;
    const html = sanitizeElement(section).outerHTML;

    expect(html).not.toContain("secret");
    expect(html).not.toContain("private note");
    expect(html).not.toContain("draft password");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("abc");
    expect(html).not.toContain("xyz");
    expect(html).not.toContain("srcdoc");
    expect(html).not.toContain("<script");
    expect(html).toContain("Visible description");
    expect(html).toContain("[editable content omitted]");
  });

  it("removes secret attributes and unsafe embedded resource URLs", () => {
    document.body.innerHTML = `
      <section data-session-token="secret" style="background: url(data:text/plain,secret)">
        <button formaction="/submit?auth=abc">Submit</button>
        <img src="data:text/plain,private" srcset="/image?token=abc 2x">
        <svg><use xlink:href="/sprite.svg?key=abc#icon"></use></svg>
      </section>`;

    const html = sanitizeElement(
      document.querySelector("section") as Element
    ).outerHTML;

    expect(html).not.toContain("secret");
    expect(html).not.toContain("data:text");
    expect(html).not.toContain("srcset");
    expect(html).not.toContain("style=");
    expect(html).toContain("auth=%5Bredacted%5D");
    expect(html).toContain("key=%5Bredacted%5D");
  });

  it("removes the contents of a selected script root", () => {
    document.body.innerHTML = `<script id="selected">const token = "private"</script>`;
    const html = sanitizeElement(
      document.querySelector("script") as Element
    ).outerHTML;

    expect(html).toBe('<script id="selected"></script>');
    expect(html).not.toContain("private");
  });

  it("redacts likely secret query parameters while preserving safe ones", () => {
    expect(
      redactUrl(
        "https://example.test/page?view=grid&access_token=abc&code=123#details"
      )
    ).toBe(
      "https://example.test/page?view=grid&access_token=%5Bredacted%5D&code=%5Bredacted%5D#details"
    );
    expect(redactUrl("/page?view=grid")).toBe("/page?view=grid");
    expect(
      redactUrl("https://example.test/#/callback?access_token=abc&view=grid")
    ).toBe(
      "https://example.test/#/callback?access_token=%5Bredacted%5D&view=grid"
    );
    expect(redactUrl("https://example.test/#token=abc&state=ready")).toBe(
      "https://example.test/#token=%5Bredacted%5D&state=ready"
    );
    expect(
      redactUrl("https://example.test/?accessToken=abc&apiKey=def&jwt=ghi")
    ).toBe(
      "https://example.test/?accessToken=%5Bredacted%5D&apiKey=%5Bredacted%5D&jwt=%5Bredacted%5D"
    );
  });

  it("creates bounded text and HTML previews", () => {
    const section = document.createElement("section");
    section.textContent = "x".repeat(12_000);
    document.body.append(section);
    const context = createElementContext(section);

    expect(context.text.length).toBeLessThanOrEqual(2_000);
    expect(context.outerHtml.length).toBeLessThanOrEqual(10_000);
    expect(context.tagName).toBe("section");
  });

  it("never copies editable or form values into enriched context", () => {
    document.body.innerHTML = `
      <main>
        <div contenteditable="true"><span id="draft">private draft token</span></div>
        <input value="account secret" aria-label="Account number">
        <span id="selected">Visible label</span>
        <script>const password = "do not send"</script>
      </main>`;

    const editableContext = createElementContext(
      document.querySelector("#draft") as Element
    );
    const selectedContext = createElementContext(
      document.querySelector("#selected") as Element
    );
    const serialized = JSON.stringify({ editableContext, selectedContext });

    expect(editableContext.text).toBe("");
    expect(editableContext.accessibleName).toBeNull();
    expect(serialized).not.toContain("private draft token");
    expect(serialized).not.toContain("account secret");
    expect(serialized).not.toContain("do not send");
  });

  it("keeps the total element payload conservatively bounded", () => {
    const huge = "z".repeat(20_000);
    document.body.innerHTML = `
      <main id="${"m".repeat(2_000)}" aria-label="${huge}">
        <section class="${Array.from({ length: 30 }, () => huge).join(" ")}">
          <div><span id="target" aria-label="${huge}">${huge}</span></div>
          <aside title="${huge}">${huge}</aside>
        </section>
      </main>`;

    const context = createElementContext(
      document.querySelector("#target") as Element
    );
    expect(context.selector.length).toBeLessThanOrEqual(4_096);
    expect(context.xpath.length).toBeLessThanOrEqual(4_096);
    expect(context.searchHints.every((hint) => hint.length <= 300)).toBe(true);
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(40_000);
  });
});
