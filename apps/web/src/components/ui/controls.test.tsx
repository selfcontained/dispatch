// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { Button } from "./button";
import { DropdownMenuItem } from "./dropdown-menu";
import { IconButton } from "./icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { SegmentedControl, SegmentedControlItem } from "./segmented-control";
import { SplitButton } from "./split-button";
import { Hint } from "./tooltip";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);
afterEach(cleanup);

it("lets wrap replace a size's fixed height", () => {
  render(<Button wrap>Long label</Button>);
  const classes = screen.getByRole("button").className.split(" ");
  expect(classes).toContain("h-auto");
  expect(classes).toContain("min-h-9");
  expect(classes).not.toContain("h-9");
});

it("keeps a trigger's open state through IconButton and Hint", () => {
  render(
    <>
      <Popover>
        <PopoverTrigger asChild>
          <IconButton label="Settings" />
        </PopoverTrigger>
        <PopoverContent>Panel one</PopoverContent>
      </Popover>
      <Popover>
        <PopoverTrigger asChild>
          <Hint label="More">
            <button>More</button>
          </Hint>
        </PopoverTrigger>
        <PopoverContent>Panel two</PopoverContent>
      </Popover>
    </>
  );
  for (const name of ["Settings", "More"]) {
    const trigger = screen.getByRole("button", { name });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("data-state")).toBe("open");
    fireEvent.click(trigger);
  }
});

it("shows a hint when tabbed to, not when focus is placed", () => {
  render(<IconButton label="Close" />);
  const button = screen.getByRole("button", { name: "Close" });
  fireEvent.keyDown(document.body, { key: "Escape" });
  fireEvent.focus(button);
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.blur(button);
  fireEvent.keyDown(document.body, { key: "Tab" });
  fireEvent.focus(button);
  expect(screen.getByRole("tooltip").textContent).toBe("Close");
});

it("never clears a segmented control's selection", () => {
  const change = vi.fn();
  render(
    <SegmentedControl aria-label="View" value="a" onValueChange={change}>
      <SegmentedControlItem value="a" hint="The first">
        A
      </SegmentedControlItem>
      <SegmentedControlItem value="b">B</SegmentedControlItem>
    </SegmentedControl>
  );
  const selected = screen.getByRole("radio", { name: "A" });
  expect(selected.getAttribute("data-state")).toBe("on");
  fireEvent.click(selected);
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("radio", { name: "B" }));
  expect(change).toHaveBeenCalledWith("b");
});

it("runs each half of a split button on its own", async () => {
  const run = vi.fn();
  const pick = vi.fn();
  render(
    <SplitButton
      onClick={run}
      menuLabel="Choose"
      menu={<DropdownMenuItem onSelect={pick}>Other</DropdownMenuItem>}
    >
      Run
    </SplitButton>
  );
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  expect(run).toHaveBeenCalledOnce();
  fireEvent.keyDown(screen.getByRole("button", { name: "Choose" }), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Other" }));
  expect(pick).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledOnce();
});
