import { act, fireEvent } from "@testing-library/react";

/** Reads an element's Hint the way a keyboard user does: by tabbing to it. */
export function hintText(element: Element): string {
  fireEvent.keyDown(document.body, { key: "Tab" });
  act(() => {
    fireEvent.focus(element);
  });
  const text = document.querySelector('[role="tooltip"]')?.textContent ?? "";
  act(() => {
    fireEvent.blur(element);
  });
  return text;
}
