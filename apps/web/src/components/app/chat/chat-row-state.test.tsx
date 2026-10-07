// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ChatRowStateContext, useChatRowState } from "./chat-row-state";

afterEach(cleanup);

function Disclosure() {
  const [open, setOpen] = useChatRowState("expanded", false);
  return (
    <button onClick={() => setOpen((value) => !value)}>
      {open ? "Expanded" : "Collapsed"}
    </button>
  );
}

it("retains disclosures across offscreen unmounts without sharing between rows", () => {
  const first = new Map<string, unknown>();
  const second = new Map<string, unknown>();
  const { rerender } = render(
    <ChatRowStateContext.Provider value={first}>
      <Disclosure />
    </ChatRowStateContext.Provider>
  );
  fireEvent.click(screen.getByText("Collapsed"));
  rerender(<></>);
  rerender(
    <ChatRowStateContext.Provider value={first}>
      <Disclosure />
    </ChatRowStateContext.Provider>
  );
  expect(screen.getByText("Expanded")).toBeTruthy();
  rerender(<></>);
  rerender(
    <ChatRowStateContext.Provider value={second}>
      <Disclosure />
    </ChatRowStateContext.Provider>
  );
  expect(screen.getByText("Collapsed")).toBeTruthy();
});
