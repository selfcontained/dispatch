// @vitest-environment jsdom
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sheet, SheetHeader, type SheetProps } from "./sheet";

afterEach(cleanup);

type Variant = Pick<
  SheetProps,
  "modal" | "docked" | "dismissable" | "keepMounted" | "keepOpen" | "onEscape"
>;

function Example({ onClosed, ...variant }: Variant & { onClosed: () => void }) {
  const [open, setOpen] = useState(false);
  const close = () => {
    setOpen(false);
    onClosed();
  };
  return (
    <>
      <button onClick={() => setOpen(true)}>Opener</button>
      <button data-keep="">Switcher</button>
      <p>Page</p>
      <Sheet
        open={open}
        onOpenChange={close}
        label="Details"
        dialog
        autoFocus
        width={400}
        {...variant}
      >
        <SheetHeader title="Details" onClose={close} />
        <input
          aria-label="Handles Escape"
          onKeyDown={(event) => {
            if (event.key === "Escape") event.preventDefault();
          }}
        />
        <input aria-label="Plain" />
      </Sheet>
    </>
  );
}

async function openSheet(variant: Variant = {}) {
  const onClosed = vi.fn();
  render(<Example onClosed={onClosed} {...variant} />);
  const opener = screen.getByRole("button", { name: "Opener" });
  opener.focus();
  fireEvent.click(opener);
  // The layer starts listening for presses after the one that opened it.
  await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  return { onClosed, opener };
}

describe.each([
  ["modal", {}],
  ["portalled", { keepMounted: false }],
  ["floating", { modal: false }],
] as Array<[string, Variant]>)("a %s sheet", (kind, variant) => {
  const pressOutside = () => {
    if (kind === "floating") fireEvent.pointerDown(screen.getByText("Page"));
    else fireEvent.click(document.querySelector("[data-sheet-scrim]")!);
  };

  it.each([
    [
      "the close button",
      () => fireEvent.click(screen.getByRole("button", { name: "Close" })),
    ],
    [
      "Escape",
      () =>
        fireEvent.keyDown(screen.getByLabelText("Plain"), { key: "Escape" }),
    ],
    ["a press outside", pressOutside],
  ])("closes from %s and returns focus to its opener", async (_, dismiss) => {
    const { onClosed, opener } = await openSheet(variant);
    expect(screen.getByRole("dialog", { name: "Details" })).toBeTruthy();

    dismiss();

    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("leaves Escape to what inside it handles Escape", async () => {
    const { onClosed } = await openSheet(variant);
    fireEvent.keyDown(screen.getByLabelText("Handles Escape"), {
      key: "Escape",
    });
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("stays for a press inside", async () => {
    const { onClosed } = await openSheet(variant);
    fireEvent.pointerDown(screen.getByLabelText("Plain"));
    fireEvent.click(screen.getByLabelText("Plain"));
    expect(onClosed).not.toHaveBeenCalled();
  });
});

describe("a sheet beside a live page", () => {
  it("leaves the first press to an open popover", async () => {
    const { onClosed } = await openSheet({ modal: false });
    const popper = document.createElement("div");
    popper.setAttribute("data-radix-popper-content-wrapper", "");
    popper.innerHTML = '<div data-state="open"></div>';
    document.body.append(popper);

    fireEvent.pointerDown(screen.getByText("Page"));
    expect(onClosed).not.toHaveBeenCalled();

    popper.remove();
    fireEvent.pointerDown(screen.getByText("Page"));
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("stays for what switches what it shows", async () => {
    const { onClosed } = await openSheet({
      modal: false,
      keepOpen: "[data-keep]",
    });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Switcher" }));
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("is a column when docked: only its button closes it", async () => {
    const { onClosed } = await openSheet({ modal: false, docked: true });
    fireEvent.keyDown(screen.getByLabelText("Plain"), { key: "Escape" });
    fireEvent.pointerDown(screen.getByText("Page"));
    expect(onClosed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClosed).toHaveBeenCalledTimes(1);
  });
});
