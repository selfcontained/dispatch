// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ComposerHighlights, splitAtTokens } from "./composer-highlights";
import { atTokenAt } from "./composer-tokens";

afterEach(cleanup);

describe("splitAtTokens", () => {
  it("marks @paths at a word boundary and leaves emails and plain text alone", () => {
    expect(splitAtTokens("look at @apps/web/ and @README.md now")).toEqual([
      { text: "look at ", token: false },
      { text: "@apps/web/", token: true },
      { text: " and ", token: false },
      { text: "@README.md", token: true },
      { text: " now", token: false },
    ]);
    expect(splitAtTokens("@~/Downloads/")).toEqual([
      { text: "@~/Downloads/", token: true },
    ]);
    expect(splitAtTokens("mail me@example.com")).toEqual([
      { text: "mail me@example.com", token: false },
    ]);
    expect(splitAtTokens("")).toEqual([]);
  });

  it("agrees with the picker's rule: every painted token is what atTokenAt would open", () => {
    const samples = [
      "look at @apps/web/ and @README.md now",
      "@node_modules/@types/ then me@example.com\n@~/x",
      "trailing @src/",
      "@ alone and @@double",
    ];
    for (const text of samples) {
      let offset = 0;
      for (const segment of splitAtTokens(text)) {
        const end = offset + segment.text.length;
        if (segment.token) {
          expect(atTokenAt(text, end)).toEqual({
            query: segment.text.slice(1),
            start: offset,
            end,
          });
        } else {
          // No word inside a plain run is a token at its own end.
          for (const m of segment.text.matchAll(/\S+/g)) {
            const wordEnd = offset + (m.index ?? 0) + m[0].length;
            expect(atTokenAt(text, wordEnd)).toBeNull();
          }
        }
        offset = end;
      }
    }
  });
});

describe("ComposerHighlights", () => {
  it("renders nothing without a token, and paints every glyph once when there is one", () => {
    const { rerender } = render(<ComposerHighlights text="plain words" />);
    expect(screen.queryByTestId("chat-composer-highlights")).toBeNull();
    rerender(<ComposerHighlights text={"see @src/index.ts\n"} />);
    const layer = screen.getByTestId("chat-composer-highlights");
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    // Plain runs carry the foreground: the field draws transparent meanwhile.
    expect(layer.className).toContain("text-foreground");
    expect(layer.className).toContain("[scrollbar-gutter:stable]");
    expect(
      screen.getAllByTestId("chat-composer-token").map((t) => t.textContent)
    ).toEqual(["@src/index.ts"]);
    // The mirror carries the whole text so the token lands where the field draws it.
    expect(layer.textContent).toBe("see @src/index.ts\n​");
  });

  it("dims with the field when the composer is disabled", () => {
    render(<ComposerHighlights text="see @src/" disabled />);
    expect(screen.getByTestId("chat-composer-highlights").className).toContain(
      "opacity-50"
    );
  });
});
