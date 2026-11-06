// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { splitPaneStateAtomFamily } from "@/lib/store";
import { useCenterPaneLayout } from "./use-center-pane-layout";

afterEach(cleanup);
function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { splitState } = useCenterPaneLayout({
    focusedAgentId: "agent",
    isMobile: false,
    activeTab: location.pathname.endsWith("files") ? "files" : "changes",
  });
  return (
    <>
      <output>
        {splitState.left}/{splitState.right}
      </output>
      <button
        onClick={() =>
          navigate("/agents/agent/files?files.path=nested%2Fname.txt")
        }
      >
        Open
      </button>
      <button onClick={() => navigate(-1)}>Back</button>
      <button onClick={() => navigate(1)}>Forward</button>
    </>
  );
}
it("reveals Files from a split deep link and restores Changes on Back without changing the saved Agent pane", () => {
  const store = createStore();
  const atom = splitPaneStateAtomFamily("agent");
  store.set(atom, {
    mode: "split",
    left: "changes",
    right: "agent",
    sizes: [40, 60],
  });
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={["/agents/agent/changes"]}>
        <Layout />
      </MemoryRouter>
    </Provider>
  );
  expect(screen.getByText("changes/agent")).toBeTruthy();
  fireEvent.click(screen.getByText("Open"));
  expect(screen.getByText("files/agent")).toBeTruthy();
  fireEvent.click(screen.getByText("Back"));
  expect(screen.getByText("changes/agent")).toBeTruthy();
  fireEvent.click(screen.getByText("Forward"));
  expect(screen.getByText("files/agent")).toBeTruthy();
  expect(store.get(atom)).toEqual({
    mode: "split",
    left: "changes",
    right: "agent",
    sizes: [40, 60],
  });
});
