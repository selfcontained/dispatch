// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentPreview } from "./agent-preview";
import { api } from "@/lib/api";
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
afterEach(cleanup);

it.each([
  ["/some-preview", true],
  ["https://preview.test", true],
  ["//other.test", false],
  ["/\\other.test", false],
  ["/\t/other.test", false],
  ["javascript:alert(1)", false],
])("handles attachment destination %s safely", async (url, visible) => {
  vi.mocked(api).mockResolvedValue({
    preview: { url, title: "Current preview" },
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AgentPreview agentId={url} />
    </QueryClientProvider>
  );
  await waitFor(() =>
    expect(client.getQueryState(["agent-preview", url])?.status).toBe("success")
  );
  const link = screen.queryByRole("link", { name: "Current preview" });
  if (visible) expect(link?.getAttribute("href")).toBe(url);
  else expect(link).toBeNull();
});
