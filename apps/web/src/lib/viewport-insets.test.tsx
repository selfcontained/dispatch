// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { OVERLAY_EDGE_GAP, safeCollisionPadding } from "./viewport-insets";

const { contentProps } = vi.hoisted(() => ({
  contentProps: [] as Array<Record<string, unknown>>,
}));
vi.mock("@radix-ui/react-popover", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@radix-ui/react-popover")>();
  const React = await import("react");
  return {
    ...actual,
    Portal: ({ children }: { children: React.ReactNode }) => children,
    Content: React.forwardRef<HTMLDivElement, Record<string, unknown>>(
      (props, ref) => {
        contentProps.push(props);
        return <div ref={ref} data-testid="content" />;
      }
    ),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  contentProps.length = 0;
});

const INSETS = { top: 24, right: 0, bottom: 20, left: 0 };

describe("safeCollisionPadding", () => {
  it("adds the default gap beyond each safe-area inset", () => {
    expect(safeCollisionPadding(INSETS)).toEqual({
      top: 24 + OVERLAY_EDGE_GAP,
      right: OVERLAY_EDGE_GAP,
      bottom: 20 + OVERLAY_EDGE_GAP,
      left: OVERLAY_EDGE_GAP,
    });
  });

  it("keeps a caller's numeric padding as the gap past the inset", () => {
    expect(safeCollisionPadding(INSETS, 12)).toEqual({
      top: 36,
      right: 12,
      bottom: 32,
      left: 12,
    });
  });

  it("keeps per-side padding and defaults the sides it leaves out", () => {
    expect(safeCollisionPadding(INSETS, { top: 0, left: 16 })).toEqual({
      top: 24,
      right: OVERLAY_EDGE_GAP,
      bottom: 20 + OVERLAY_EDGE_GAP,
      left: 16,
    });
  });
});

describe("PopoverContent", () => {
  it("keeps the popover clear of the iOS status bar and home indicator", async () => {
    // jsdom has no env(); report the insets an installed iPad app would.
    const real = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
      const style = real(el, pseudo);
      // The probe is a hidden, fixed, zero-size element on body.
      const probe = el as HTMLElement;
      if (
        probe.parentElement !== document.body ||
        probe.style.visibility !== "hidden" ||
        probe.style.position !== "fixed"
      ) {
        return style;
      }
      return {
        ...style,
        getPropertyValue: (name: string) =>
          ({ "padding-top": "24px", "padding-bottom": "20px" })[name] ?? "0px",
      } as CSSStyleDeclaration;
    });
    const { Popover, PopoverContent } = await import("@/components/ui/popover");
    render(
      <Popover open>
        <PopoverContent collisionPadding={12}>Body</PopoverContent>
      </Popover>
    );
    expect(contentProps.at(-1)?.collisionPadding).toEqual({
      top: 36,
      right: 12,
      bottom: 32,
      left: 12,
    });
  });
});

describe("useSafeAreaInsets", () => {
  // Reports `top` for the safe-area probe and counts how often it is read.
  function mockProbe(initialTop: number) {
    const state = { top: initialTop, measurements: 0 };
    const real = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
      const style = real(el, pseudo);
      const probe = el as HTMLElement;
      if (
        probe.parentElement !== document.body ||
        probe.style.visibility !== "hidden" ||
        probe.style.position !== "fixed"
      ) {
        return style;
      }
      state.measurements += 1;
      return {
        ...style,
        getPropertyValue: (name: string) =>
          name === "padding-top" ? `${state.top}px` : "0px",
      } as CSSStyleDeclaration;
    });
    return state;
  }

  async function freshHook() {
    vi.resetModules();
    const { useSafeAreaInsets } = await import("./viewport-insets");
    const seen: number[] = [];
    function Consumer({ index }: { index: number }) {
      seen[index] = useSafeAreaInsets().top;
      return null;
    }
    return { Consumer, seen };
  }

  it("measures once for many subscribers and once per resize", async () => {
    const probe = mockProbe(24);
    const { Consumer, seen } = await freshHook();
    const COUNT = 50;
    render(
      <>
        {Array.from({ length: COUNT }, (_, index) => (
          <Consumer key={index} index={index} />
        ))}
      </>
    );
    expect(probe.measurements).toBe(1);
    expect(seen).toHaveLength(COUNT);
    expect(seen.every((top) => top === 24)).toBe(true);

    probe.top = 47;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(probe.measurements).toBe(2);
    expect(seen.every((top) => top === 47)).toBe(true);
  });

  it("re-measures for the first subscriber after all of them detached", async () => {
    const probe = mockProbe(24);
    const { Consumer, seen } = await freshHook();
    const first = render(<Consumer index={0} />);
    expect(probe.measurements).toBe(1);
    first.unmount();

    // Changed while nobody was listening for window events.
    probe.top = 0;
    render(
      <>
        <Consumer index={1} />
        <Consumer index={2} />
      </>
    );
    expect(probe.measurements).toBe(2);
    expect(seen[1]).toBe(0);
    expect(seen[2]).toBe(0);
  });
});
