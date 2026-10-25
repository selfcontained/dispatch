// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useSectionNavigate } from "./use-section-navigate";

const navigate = vi.fn();
vi.mock("@/hooks/use-projects", () => ({
  useProjectNavigate: () => navigate,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("closes the mobile sheet on every section tap, Tasks included", () => {
  const setMobileLeftOpen = vi.fn();
  const { result } = renderHook(() =>
    useSectionNavigate({ isMobile: true, setMobileLeftOpen })
  );
  result.current("tasks");
  expect(setMobileLeftOpen).toHaveBeenCalledWith(false);
  expect(setMobileLeftOpen).not.toHaveBeenCalledWith(true);
  expect(navigate).toHaveBeenCalledWith("/tasks");
  for (const section of ["agents", "automations", "activity", "settings"]) {
    result.current(section as Parameters<typeof result.current>[0]);
  }
  expect(setMobileLeftOpen).toHaveBeenCalledTimes(5);
  expect(setMobileLeftOpen).not.toHaveBeenCalledWith(true);
  expect(navigate).toHaveBeenLastCalledWith("/settings");
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
