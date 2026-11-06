// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Provider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenFullFileButton } from "./open-full-file-button";

const { navigate, api, error } = vi.hoisted(() => ({
  navigate: vi.fn(),
  api: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/hooks/use-projects", () => ({ useProjectNavigate: () => navigate }));
vi.mock("@/lib/api", () => ({ api }));
vi.mock("sonner", () => ({ toast: { error } }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
});
function mount(deleted = false) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
  return render(
    <Provider>
      <OpenFullFileButton
        agentId="same-agent"
        workspace="/effective workspace"
        path="nested/new name.ts"
        deleted={deleted}
      />
    </Provider>
  );
}
describe("Open full file", () => {
  it("checks the exact current path in the effective workspace and pushes Files while preserving drawer pages", async () => {
    window.history.replaceState(
      null,
      "",
      "/?file=old&path=stale&line=9&finding=stale&thread=review&task=task-id"
    );
    api.mockResolvedValue({ kind: "text", text: "full content" });
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Open full file: nested/new name.ts" })
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    const request = new URL(api.mock.calls[0][0], "http://localhost");
    expect(request.searchParams.get("workspace")).toBe("/effective workspace");
    expect(request.searchParams.get("path")).toBe("nested/new name.ts");
    const target = new URL(navigate.mock.calls[0][0], "http://localhost");
    expect(target.pathname).toBe("/agents/same-agent/files");
    expect(target.searchParams.get("files.path")).toBe("nested/new name.ts");
    expect(target.searchParams.get("thread")).toBe("review");
    expect(target.searchParams.get("task")).toBe("task-id");
    for (const key of ["file", "path", "line", "finding"])
      expect(target.searchParams.has(key)).toBe(false);
  });
  it("keeps the diff visible and explains an absent working-tree file", async () => {
    api.mockRejectedValue(new Error("not found"));
    mount();
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Full file unavailable")
      )
    );
    expect(navigate).not.toHaveBeenCalled();
  });
  it("disables historical deleted files without reading or navigating", () => {
    mount(true);
    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain("unavailable");
    fireEvent.click(button);
    expect(api).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
