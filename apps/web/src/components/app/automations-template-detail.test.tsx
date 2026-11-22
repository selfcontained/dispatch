// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

import { api } from "@/lib/api";

import { TemplateDetailPane } from "./automations-template-detail";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));
vi.mock("@/hooks/use-projects", () => ({
  useProjects: () => ({ data: [], isSuccess: true }),
}));
vi.mock("@/hooks/use-agent-model-catalog", () => ({
  useAgentModelCatalog: () => ({ normalizeModel: (model: unknown) => model }),
}));
vi.mock("@/components/app/automations-form-fields", () => ({
  TemplateConfigFields: () => null,
}));
vi.mock("@/components/app/duplicate-template-dialog", () => ({
  DuplicateTemplateDialog: () => null,
}));
vi.mock("@/components/app/automations-launch-dialog", () => ({
  LaunchTemplateDialog: () => null,
}));
afterEach(cleanup);

it("shows a failed delete in the dialog and can retry it", async () => {
  let attempts = 0;
  vi.mocked(api).mockImplementation((async (
    path: string,
    init?: RequestInit
  ) => {
    if (init?.method === "DELETE") {
      if (++attempts === 1) throw new Error("Delete broke");
      return {};
    }
    if (path.startsWith("/api/v1/templates"))
      return [
        {
          id: "tpl_1",
          name: "Nightly",
          directory: "/repo",
          agentType: "claude",
        },
      ];
    return [];
  }) as typeof api);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/automations/templates/tpl_1"]}>
        <Routes>
          <Route
            path="/automations/templates/:templateId"
            element={<TemplateDetailPane enabledAgentTypes={["claude"]} />}
          />
          <Route path="/automations" element={<p>Templates home</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain(
    "Delete broke"
  );

  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.getByText("Templates home")).toBeTruthy());
  expect(attempts).toBe(2);
});
