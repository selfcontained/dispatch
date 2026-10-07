// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DrawerStack } from "./drawer-stack";

vi.mock("framer-motion", async (importOriginal) => {
  const { createFramerMotionMock } =
    await import("@/test-utils/framer-motion-mock");
  return createFramerMotionMock(importOriginal);
});

afterEach(cleanup);

describe("DrawerStack", () => {
  it("keeps every page mounted and marks only the top one interactive", () => {
    render(
      <DrawerStack
        pages={[
          { key: "home", node: <div>home</div> },
          { key: "thread:t1", node: <div>thread</div> },
          { key: "finding:t1:f1", node: <div>finding</div> },
        ]}
      />
    );
    expect(screen.getByTestId("drawer-stack").getAttribute("data-depth")).toBe(
      "2"
    );
    const pages = screen.getAllByTestId("drawer-page");
    expect(pages.map((p) => p.getAttribute("data-page-key"))).toEqual([
      "home",
      "thread:t1",
      "finding:t1:f1",
    ]);
    expect(pages.map((p) => p.getAttribute("data-top"))).toEqual([
      "false",
      "false",
      "true",
    ]);
    expect(pages[0]!.getAttribute("aria-hidden")).toBe("true");
    expect(pages[2]!.getAttribute("aria-hidden")).toBeNull();
    expect(pages[0]!.className).toContain("pointer-events-none");
    expect(pages[2]!.className).not.toContain("pointer-events-none");
  });
});
