// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChangesSvgPreview } from "./changes-svg-preview";
import { api } from "@/lib/api";
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function mount() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ChangesSvgPreview agentId="agent" workspace="/work" path="viewbox.svg">
        <p>Original diff</p>
      </ChangesSvgPreview>
    </QueryClientProvider>
  );
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
