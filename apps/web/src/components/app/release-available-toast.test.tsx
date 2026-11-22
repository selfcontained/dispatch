// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { ReleaseAvailableToast } from "./release-available-toast";

vi.mock("@/components/ui/toast", () => ({
  toast: { info: vi.fn(), dismiss: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
vi.mock("@/hooks/use-cached-release-info", () => ({
  useCachedReleaseInfo: () => ({
    data: { snapshot: { updateAvailable: true, latestTag: "v99.0.0" } },
  }),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount(version?: object) {
  const client = new QueryClient();
  if (version) client.setQueryData(["release", "app-version"], version);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ReleaseAvailableToast />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return client;
}

describe("release toast ownership", () => {
  it("suppresses the toast on Mac-app installs", () => {
    mount({ updateOwner: "macos-app" });
    expect(toast.info).not.toHaveBeenCalled();
  });
  it("waits for ownership before offering an update", () => {
    vi.mocked(api).mockReturnValue(new Promise(() => {}));
    mount();
    expect(toast.info).not.toHaveBeenCalled();
  });
  it("keeps the existing server update action without updateOwner", async () => {
    vi.mocked(api).mockResolvedValue({});
    mount({});
    await waitFor(() => expect(toast.info).toHaveBeenCalled());
    const options = vi.mocked(toast.info).mock.calls[0][1]!;
    if (
      options.action &&
      typeof options.action === "object" &&
      "onClick" in options.action
    ) {
      await options.action.onClick({} as never);
    }
    expect(api).toHaveBeenCalledWith("/api/v1/release/update", {
      method: "POST",
      body: JSON.stringify({ tag: "v99.0.0" }),
    });
  });
});
