// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { useDrawerRoute } from "./use-drawer-route";

function setup(search: string) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[`/agents/a1${search}`]}>
      {children}
    </MemoryRouter>
  );
  return renderHook(
    () => ({ route: useDrawerRoute(), search: useLocation().search }),
    { wrapper }
  );
}

describe("useDrawerRoute", () => {
  it("reads the stacked pages from the URL", () => {
    expect(setup("").result.current.route).toMatchObject({
      threadId: null,
      findingId: null,
      depth: 0,
    });
    expect(setup("?thread=t1").result.current.route).toMatchObject({
      threadId: "t1",
      findingId: null,
      depth: 1,
    });
    expect(setup("?thread=t1&finding=f2").result.current.route).toMatchObject({
      threadId: "t1",
      findingId: "f2",
      depth: 2,
    });
    // A finding with no thread is nothing.
    expect(setup("?finding=f2").result.current.route.depth).toBe(0);
  });

  it("pushes a thread then a finding, pops one at a time, and closes them all", () => {
    const { result } = setup("?file=x");
    act(() => result.current.route.openThread("t1"));
    expect(result.current.search).toBe("?file=x&thread=t1");
    act(() => result.current.route.openThread("t1", "f1"));
    expect(result.current.search).toBe("?file=x&thread=t1&finding=f1");
    act(() => result.current.route.back());
    expect(result.current.search).toBe("?file=x&thread=t1");
    expect(result.current.route.depth).toBe(1);
    act(() => result.current.route.openThread("t1", "f2"));
    act(() => result.current.route.closeAll());
    expect(result.current.search).toBe("?file=x");
    act(() => result.current.route.back());
    expect(result.current.search).toBe("?file=x");
  });
});
