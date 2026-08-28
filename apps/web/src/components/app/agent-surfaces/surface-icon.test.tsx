// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SURFACE_ICON_MAP, SurfaceIconGlyph } from "./surface-icon";
import type { SurfaceIcon } from "@/components/app/agent-surfaces/types";

afterEach(() => {
  cleanup();
});

describe("SurfaceIconGlyph", () => {
  it("renders a glyph for every SurfaceIcon variant", () => {
    const icons = Object.keys(SURFACE_ICON_MAP) as SurfaceIcon[];
    for (const icon of icons) {
      const { container } = render(<SurfaceIconGlyph icon={icon} />);
      expect(container.querySelector("svg")).not.toBeNull();
      cleanup();
    }
  });

  it("renders nothing when the surface has no icon", () => {
    const { container } = render(<SurfaceIconGlyph icon={undefined} />);
    expect(container.querySelector("svg")).toBeNull();
    expect(container.firstChild).toBeNull();
  });
});
