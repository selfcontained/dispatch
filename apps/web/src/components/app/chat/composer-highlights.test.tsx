// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ComposerHighlights, splitAtTokens } from "./composer-highlights";

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
});

describe("ComposerHighlights", () => {
  it("renders nothing without a token, and paints each token when there is one", () => {
    const { rerender } = render(
      <ComposerHighlights text="plain words" scrollTop={0} />
    );
    expect(screen.queryByTestId("chat-composer-highlights")).toBeNull();
    rerender(<ComposerHighlights text={"see @src/index.ts\n"} scrollTop={0} />);
    const layer = screen.getByTestId("chat-composer-highlights");
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(
      screen.getAllByTestId("chat-composer-token").map((t) => t.textContent)
    ).toEqual(["@src/index.ts"]);
    // The mirror carries the whole text so the token lands where the field draws it.
    expect(layer.textContent).toBe("see @src/index.ts\n​");
  });
});
