// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { AgentPersonaSelect } from "./agent-persona-select";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

it("updates the runner picker options when switching from a project to a bare repository", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(api).mockImplementation(async (url) => {
    const query = new URL(url, "http://localhost").searchParams;
    return {
      personas:
        query.get("projectId") === "project-a"
          ? [{ slug: "builder", name: "Builder", description: "Build" }]
          : [],
    };
  });

  const client = new QueryClient();
  const picker = (projectId: string | null) => (
    <QueryClientProvider client={client}>
      <AgentPersonaSelect
        cwd="runner://test/@session"
        projectId={projectId}
        value={null}
        onChange={vi.fn()}
      />
    </QueryClientProvider>
  );
  const view = render(picker("project-a"));
  const trigger = screen.getByRole("combobox", { name: "Persona" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(await screen.findByRole("option", { name: "Builder" })).toBeTruthy();

  view.rerender(picker(null));
  expect(
    await screen.findByRole("option", { name: "No task personas available" })
  ).toBeTruthy();
  expect(screen.queryByRole("option", { name: "Builder" })).toBeNull();
});
