// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  ActionMenu,
  ActionMenuContent,
  ActionMenuItem,
  ActionMenuSeparator,
  ActionMenuTrigger,
} from "./action-menu";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function media(width: number, coarse: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: coarse && width <= 767,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  );
}
function show(select = vi.fn()) {
  render(
    <ActionMenu label="Test actions">
      <ActionMenuTrigger asChild>
        <button>Open actions</button>
      </ActionMenuTrigger>
      <ActionMenuContent>
        <div>Session</div>
        <ActionMenuItem onSelect={select}>Rename</ActionMenuItem>
        <ActionMenuItem disabled onSelect={select}>
          Unavailable
        </ActionMenuItem>
        <ActionMenuSeparator />
        <ActionMenuItem className="text-danger">
          Delete <span>Empty first</span>
        </ActionMenuItem>
      </ActionMenuContent>
    </ActionMenu>
  );
  return select;
}
it("uses a bottom sheet on a touch phone, preserves disabled items, selects and dismisses", async () => {
  media(390, true);
  const select = show();
  fireEvent.click(screen.getByRole("button", { name: "Open actions" }));
  expect(
    await screen.findByRole("dialog", { name: "Test actions" })
  ).toBeTruthy();
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Unavailable" }));
  expect(select).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  expect(select).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
it.each([
  [820, true],
  [1280, false],
  [390, false],
])("uses a dropdown at width %i, coarse %s", async (width, coarse) => {
  media(width, coarse);
  const select = show();
  fireEvent.keyDown(screen.getByRole("button", { name: "Open actions" }), {
    key: "ArrowDown",
  });
  expect(await screen.findByRole("menu")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
  expect(select).toHaveBeenCalledTimes(1);
});

it("Escape closes a phone action sheet above its parent sheet", async () => {
  media(390, true);
  const { Sheet } = await import("./sheet");
  render(
    <Sheet open onOpenChange={vi.fn()} label="Parent" keepMounted={false}>
      <ActionMenu label="Nested actions">
        <ActionMenuTrigger asChild>
          <button>Open nested</button>
        </ActionMenuTrigger>
        <ActionMenuContent>
          <ActionMenuItem>Rename</ActionMenuItem>
        </ActionMenuContent>
      </ActionMenu>
    </Sheet>
  );
  fireEvent.click(screen.getByRole("button", { name: "Open nested" }));
  const child = await screen.findByRole("dialog", { name: "Nested actions" });
  fireEvent.keyDown(child, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Nested actions" })).toBeNull()
  );
  expect(screen.getByRole("dialog", { name: "Parent" })).toBeTruthy();
});
