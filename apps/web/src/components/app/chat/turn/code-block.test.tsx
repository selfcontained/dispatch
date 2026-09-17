// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CodeBlock, COLLAPSED_LINES, PathList } from "./code-block";

afterEach(cleanup);

describe("CodeBlock", () => {
  it("clips a long block and expands to full height on demand", () => {
    const code = Array.from(
      { length: COLLAPSED_LINES + 10 },
      (_, i) => `line ${i}`
    ).join("\n");
    render(<CodeBlock code={code} language="json" startLine={1} />);
    const block = screen.getByTestId("harness-code");
    expect(block.getAttribute("data-expanded")).toBe("false");
    const toggle = screen.getByTestId("harness-block-toggle");
    expect(toggle.textContent).toBe(`Show all ${COLLAPSED_LINES + 10} lines`);
    fireEvent.click(toggle);
    expect(block.getAttribute("data-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Collapse");
    // Every line is present in the DOM either way; nothing scrolls inside.
    expect(block.querySelectorAll("code")).toHaveLength(COLLAPSED_LINES + 10);
    expect(block.querySelector(".overflow-auto")).toBeNull();
  });

  it("shows a short block whole, with no toggle", () => {
    render(<CodeBlock code={"a\nb"} language="json" />);
    expect(screen.queryByTestId("harness-block-toggle")).toBeNull();
    expect(
      screen.getByTestId("harness-code").getAttribute("data-expanded")
    ).toBeNull();
  });

  it("numbers wrapped rows from the start line", () => {
    render(<CodeBlock code={"x\ny"} language="json" startLine={40} />);
    expect(screen.getByTestId("harness-code").textContent).toContain("40");
    expect(screen.getByTestId("harness-code").textContent).toContain("41");
  });
});

describe("PathList", () => {
  it("splits directory and file name", () => {
    render(<PathList text={"a/b/c.ts\nREADME.md"} />);
    const list = screen.getByTestId("harness-paths");
    expect(list.textContent).toContain("a/b/");
    expect(list.textContent).toContain("c.ts");
    expect(list.querySelector(".overflow-auto")).toBeNull();
  });
});
