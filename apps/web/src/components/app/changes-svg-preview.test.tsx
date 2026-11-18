// @vitest-environment jsdom
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChangesSvgPreview } from "./changes-svg-preview";
import { api } from "@/lib/api";
import { applyDiffStateChanged } from "@/hooks/use-sse";
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function mount(
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
) {
  function Harness() {
    const [view, setView] = useState("diff");
    return (
      <QueryClientProvider client={client}>
        <ChangesSvgPreview
          agentId="agent"
          workspace="/work"
          path="viewbox.svg"
          view={view}
          onViewChange={setView}
        >
          <p>Original diff</p>
        </ChangesSvgPreview>
      </QueryClientProvider>
    );
  }
  return render(<Harness />);
}
it("defaults to Diff, loads current SVG only on Preview, and switches back", async () => {
  vi.mocked(api).mockResolvedValue({
    kind: "svg",
    src: "data:image/svg+xml;base64,PHN2Zy8+",
  });
  mount();
  expect(screen.getByText("Original diff")).toBeTruthy();
  expect(api).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("radio", { name: "Preview" }));
  expect((await screen.findByRole("img")).getAttribute("src")).toContain(
    "data:image/svg+xml"
  );
  expect(api).toHaveBeenCalledWith(
    expect.stringContaining("path=viewbox.svg&file=true"),
    expect.anything()
  );
  expect(screen.queryByText("Original diff")).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "Diff" }));
  expect(screen.getByText("Original diff")).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
});
it("does not render a source for non-SVG bytes", async () => {
  vi.mocked(api).mockResolvedValue({ kind: "text", text: "<html>fake</html>" });
  mount();
  fireEvent.click(screen.getByRole("radio", { name: "Preview" }));
  expect(await screen.findByText(/SVG preview unavailable/)).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
});

it("refreshes an active Preview on a diff-change event while Diff stays request-free", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  vi.mocked(api).mockResolvedValue({
    kind: "svg",
    src: "data:image/svg+xml;base64,b2xk",
  });
  mount(client);
  act(() => applyDiffStateChanged(client, "agent", null));
  expect(api).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("radio", { name: "Preview" }));
  await screen.findByRole("img");
  vi.mocked(api).mockResolvedValue({
    kind: "svg",
    src: "data:image/svg+xml;base64,bmV3",
  });
  act(() => applyDiffStateChanged(client, "agent", null));
  await waitFor(() =>
    expect(screen.getByRole("img").getAttribute("src")).toContain("bmV3")
  );
  fireEvent.click(screen.getByRole("radio", { name: "Diff" }));
  vi.mocked(api).mockClear();
  act(() => applyDiffStateChanged(client, "agent", null));
  expect(api).not.toHaveBeenCalled();
});
