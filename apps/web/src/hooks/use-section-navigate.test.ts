// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useSectionNavigate } from "./use-section-navigate";

const navigate = vi.fn();
vi.mock("jotai", async (original) => ({
  ...(await original<typeof import("jotai")>()),
  useAtom: () => [null, vi.fn()],
}));
vi.mock("react-router-dom", () => ({ useLocation: () => ({ key: "test" }) }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
vi.mock("@/hooks/use-projects", () => ({
  useProjectNavigate: () => navigate,
  useProjectScope: () => ({ projectId: null }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("closes the mobile sheet on section taps, Tasks included", () => {
  const setMobileLeftOpen = vi.fn();
  const { result } = renderHook(() =>
    useSectionNavigate({ isMobile: true, setMobileLeftOpen })
  );
  result.current("tasks");
  expect(setMobileLeftOpen).toHaveBeenCalledWith(false);
  expect(setMobileLeftOpen).not.toHaveBeenCalledWith(true);
  expect(navigate).toHaveBeenCalledWith("/tasks");
  for (const section of ["agents", "activity", "settings"]) {
    result.current(section as Parameters<typeof result.current>[0]);
  }
  expect(setMobileLeftOpen).toHaveBeenCalledTimes(4);
  expect(setMobileLeftOpen).not.toHaveBeenCalledWith(true);
  expect(navigate).toHaveBeenLastCalledWith("/settings");
});

it("keeps the sheet for Automations, whose pane is a select prompt", () => {
  const setMobileLeftOpen = vi.fn();
  const { result } = renderHook(() =>
    useSectionNavigate({ isMobile: true, setMobileLeftOpen })
  );
  result.current("automations");
  expect(setMobileLeftOpen).not.toHaveBeenCalled();
  expect(navigate).toHaveBeenCalledWith("/automations");
});

it("leaves the sidebar alone on desktop", () => {
  const setMobileLeftOpen = vi.fn();
  const { result } = renderHook(() =>
    useSectionNavigate({ isMobile: false, setMobileLeftOpen })
  );
  result.current("activity");
  expect(setMobileLeftOpen).not.toHaveBeenCalled();
  expect(navigate).toHaveBeenCalledWith("/activity/metrics");
});
