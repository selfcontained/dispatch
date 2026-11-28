// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  CWD_HISTORY_KEY,
  CWD_HISTORY_USAGE_KEY,
  useCwdHistory,
} from "./create-agent-dialog-utils";
import { PathInput } from "./path-input";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));
const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);
const payload = {
  projects: ["/work/alpha", "/work/beta"],
  projectOptions: [
    {
      path: "/work/alpha",
      usageCount: 2,
      latestCreatedAt: "2026-01-01",
      iconUrl: "/local-alpha.png",
    },
    {
      path: "/work/beta",
      usageCount: 1,
      latestCreatedAt: "2026-01-01",
      iconUrl: "/local-beta.png",
    },
  ],
};
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  apiMock.mockReset();
});
function Picker() {
  const history = useCwdHistory();
  return (
    <PathInput
      label="Folder"
      value=""
      onChange={() => {}}
      showValidation={false}
      history={history.history}
      historyMetadata={history.historyMetadata}
    />
  );
}
it("pins main local folder rendering including browser usage, ordering and server icons", async () => {
  window.localStorage.setItem(
    CWD_HISTORY_KEY,
    JSON.stringify(["/work/beta", "/remembered"])
  );
  window.localStorage.setItem(
    CWD_HISTORY_USAGE_KEY,
    JSON.stringify({ "/work/beta": 5, "/remembered": 1 })
  );
  apiMock.mockResolvedValue(payload);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Picker />
    </QueryClientProvider>
  );
  await waitFor(() => expect(apiMock).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Show suggestions" }));
  await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
    "beta/work/beta5",
    "alpha/work/alpha2",
    "remembered/remembered1",
  ]);
  expect(
    screen
      .getAllByRole("option")
      .map((o) => o.querySelector("img")?.getAttribute("src") ?? null)
  ).toEqual(["/local-beta.png", "/local-alpha.png", null]);
});

function ScopedPicker() {
  const history = useCwdHistory("/fixture-target-history");
  return (
    <PathInput
      label="Folder"
      value=""
      onChange={() => {}}
      showValidation={false}
      history={history.history}
      historyUrl={history.suggestionsUrl}
      historyMetadata={history.historyMetadata}
    />
  );
}
it("renders the same local suggestions with scoped server data and the existing browser merge", async () => {
  window.localStorage.setItem(
    CWD_HISTORY_KEY,
    JSON.stringify(["/work/beta", "/remembered"])
  );
  window.localStorage.setItem(
    CWD_HISTORY_USAGE_KEY,
    JSON.stringify({ "/work/beta": 5, "/remembered": 1 })
  );
  apiMock.mockImplementation(async (url) => {
    if (!url.startsWith("/fixture-target-history?"))
      throw new Error("Unexpected global history request: " + url);
    return { ...payload, projects: [...payload.projects, "/remembered"] };
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ScopedPicker />
    </QueryClientProvider>
  );
  await waitFor(() => expect(apiMock).toHaveBeenCalled());
  fireEvent.click(
    await screen.findByRole("button", { name: "Show suggestions" })
  );
  await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
    "beta/work/beta5",
    "alpha/work/alpha2",
    "remembered/remembered1",
  ]);
  expect(
    screen
      .getAllByRole("option")
      .map((o) => o.querySelector("img")?.getAttribute("src") ?? null)
  ).toEqual(["/local-beta.png", "/local-alpha.png", null]);
  expect(
    apiMock.mock.calls.every(([url]) =>
      url.startsWith("/fixture-target-history?")
    )
  ).toBe(true);
});
