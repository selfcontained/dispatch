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
import { EffortSettings } from "./effort-settings";
const api = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api }));
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("clears the global default to allow CLI settings", async () => {
  api.mockImplementation(async (_url: string, options?: { body?: string }) =>
    options?.body ? JSON.parse(options.body) : { effort: "medium" }
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <EffortSettings />
    </QueryClientProvider>
  );
  const select = await screen.findByTestId("settings-default-effort");
  expect(select.textContent).toContain("medium");
  fireEvent.keyDown(select, { key: "Enter" });
  fireEvent.click(
    screen.getByRole("option", {
      name: "CLI settings (no default)",
    })
  );
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/api/v1/app/settings/effort", {
      method: "POST",
      body: JSON.stringify({ effort: null }),
    })
  );
  await waitFor(() =>
    expect(select.textContent).toContain("CLI settings (no default)")
  );
});
