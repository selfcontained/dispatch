// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { WorktreeLocationSettings } from "./worktree-location-settings";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));
const apiMock = vi.mocked(api);

const missing =
  "The worktree directory /Volumes/storage/worktrees is unavailable (it does not exist).";

beforeEach(() => {
  apiMock.mockReset().mockImplementation(async (_path, init) => {
    if (init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      if (body.worktreeDirectory === "/Volumes/other/worktrees") {
        return {
          worktreeLocation: "directory",
          worktreeDirectory: body.worktreeDirectory,
        };
      }
      throw new Error(missing);
    }
    return {
      worktreeLocation: "sibling",
      worktreeDirectory: "/Volumes/storage/worktrees",
    };
  });
});

afterEach(() => cleanup());

it("keeps the folder field open when the saved folder has gone missing", async () => {
  render(<WorktreeLocationSettings />);
  fireEvent.click(await screen.findByText("Another folder"));

  const field = await screen.findByRole("textbox", { name: "Worktree folder" });
  expect(field).toHaveProperty("value", "/Volumes/storage/worktrees");
  await waitFor(() =>
    expect(apiMock).toHaveBeenCalledWith(
      "/api/v1/agents/settings",
      expect.objectContaining({ method: "POST" })
    )
  );
  // The location save failed; the folder can still be corrected.
  await screen.findByText(/Couldn.t save changes/);
  expect(screen.getByRole("textbox", { name: "Worktree folder" })).toBeTruthy();

  fireEvent.change(field, { target: { value: "/Volumes/other/worktrees" } });
  fireEvent.blur(field);
  await waitFor(() =>
    expect(apiMock).toHaveBeenLastCalledWith("/api/v1/agents/settings", {
      method: "POST",
      body: JSON.stringify({
        worktreeLocation: "directory",
        worktreeDirectory: "/Volumes/other/worktrees",
      }),
    })
  );
});

it("waits for a path when no folder was saved", async () => {
  apiMock.mockImplementation(async () => ({ worktreeLocation: "sibling" }));
  render(<WorktreeLocationSettings />);
  fireEvent.click(await screen.findByText("Another folder"));
  await screen.findByRole("textbox", { name: "Worktree folder" });
  expect(apiMock).toHaveBeenCalledTimes(1);
});
