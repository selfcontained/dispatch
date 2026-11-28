// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { TemplateListItem } from "./automations-pane";
import type { Template } from "@/hooks/use-templates";
import { api } from "@/lib/api";
import { shortPath } from "@/lib/format";
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
vi.mock("./automations-launch-dialog", () => ({
  LaunchTemplateDialog: () => null,
}));
afterEach(cleanup);
function mount(directory: string) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <TemplateListItem
          template={
            {
              id: "fixture",
              name: "Builder",
              directory,
              description: "",
            } as Template
          }
          enabledAgentTypes={["codex"]}
          selected={false}
          onSelect={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
it("pins main's controller subtitle and full folder tooltip", async () => {
  const directory = "/var/folders/a/fixture/repository";
  vi.mocked(api).mockResolvedValue({ locationLabel: directory });
  mount(directory);
  expect(await screen.findByText(shortPath(directory))).toHaveProperty(
    "title",
    directory
  );
});

it.each(["Fixture repository", "Fixture runner"])(
  "uses the saved projection label %s without exposing a locator",
  async (label) => {
    vi.mocked(api).mockResolvedValue({ locationLabel: label });
    mount("/srv/fixture/checkout");
    expect(await screen.findByText(label)).toHaveProperty("title", label);
    expect(screen.queryByText(/runner:\/\//)).toBeNull();
  }
);
