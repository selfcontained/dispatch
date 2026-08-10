// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PersonaLauncher } from "./persona-launcher";

const api = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api }));

const agent: Agent = {
  id: "agt_parent",
  name: "author",
  type: "claude",
  role: "standard",
  status: "running",
  cwd: "/repo",
  worktreePath: null,
  worktreeBranch: null,
  tmuxSession: "dispatch-agt_parent",
  agentArgs: [],
  model: null,
  fullAccess: false,
  latestEvent: null,
  mediaDir: null,
  persona: null,
  parentAgentId: null,
  createdAt: "2026-08-08T12:00:00.000Z",
  updatedAt: "2026-08-08T12:00:00.000Z",
};

const PERSONAS = [
  { slug: "ux-review", name: "UX Review", description: "ux" },
  { slug: "sec-review", name: "Security Review", description: "sec" },
];

afterEach(() => {
  cleanup();
  api.mockReset();
});

function renderLauncher() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <PersonaLauncher agent={agent} enabledAgentTypes={["claude"]} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

describe("PersonaLauncher", () => {
  it("holds the launch button disabled while the model catalog loads", async () => {
    // The catalog never settles: launching now would send model: null and
    // silently drop the preference the select is about to show.
    api.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/v1/personas")) return { personas: PERSONAS };
      return new Promise(() => {});
    });
    renderLauncher();

    fireEvent.click(await screen.findByTestId("launch-reviewer-button"));
    fireEvent.click(
      await screen.findByTestId("launch-reviewer-persona-ux-review")
    );

    expect(screen.getByTestId("launch-reviewer-submit")).toHaveProperty(
      "disabled",
      true
    );
  });

  it("exposes the persona rows as a labelled group with a live count", async () => {
    api.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/v1/personas")) return { personas: PERSONAS };
      return { models: { claude: [{ id: "opus", label: "Opus" }] } };
    });
    renderLauncher();

    fireEvent.click(await screen.findByTestId("launch-reviewer-button"));

    const group = screen.getByRole("group", { name: "Personas" });
    expect(group.querySelectorAll('[role="checkbox"]')).toHaveLength(
      PERSONAS.length
    );

    // The count region stays mounted at zero so toggles are announced.
    const count = screen.getByTestId("launch-reviewer-selected-count");
    expect(count.getAttribute("aria-live")).toBe("polite");
    expect(count.textContent).toBe("");

    fireEvent.click(screen.getByTestId("launch-reviewer-persona-ux-review"));
    expect(count.textContent).toBe("1 selected");
  });

  it("enables the launch button once the catalog resolves", async () => {
    api.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/v1/personas")) return { personas: PERSONAS };
      return { models: { claude: [{ id: "opus", label: "Opus" }] } };
    });
    renderLauncher();

    fireEvent.click(await screen.findByTestId("launch-reviewer-button"));
    fireEvent.click(
      await screen.findByTestId("launch-reviewer-persona-ux-review")
    );

    await vi.waitFor(() =>
      expect(screen.getByTestId("launch-reviewer-submit")).toHaveProperty(
        "disabled",
        false
      )
    );
  });

  it("sends the trimmed focus note with the launch request", async () => {
    api.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/v1/personas")) return { personas: PERSONAS };
      if (path.includes("/launch-review")) return { ok: true };
      if (path.includes("/review-agent-type")) return { agent };
      return { models: { claude: [{ id: "opus", label: "Opus" }] } };
    });
    renderLauncher();

    fireEvent.click(await screen.findByTestId("launch-reviewer-button"));
    fireEvent.click(
      await screen.findByTestId("launch-reviewer-persona-ux-review")
    );
    fireEvent.change(screen.getByTestId("launch-reviewer-note"), {
      target: { value: "  focus on the auth changes  " },
    });

    await vi.waitFor(() =>
      expect(screen.getByTestId("launch-reviewer-submit")).toHaveProperty(
        "disabled",
        false
      )
    );
    fireEvent.click(screen.getByTestId("launch-reviewer-submit"));

    await vi.waitFor(() => {
      const call = api.mock.calls.find((args) =>
        String(args[0]).includes("/launch-review")
      );
      expect(call).toBeDefined();
      expect(JSON.parse(call![1].body)).toMatchObject({
        personas: ["ux-review"],
        note: "focus on the auth changes",
      });
    });
  });

  it("sends note: null when the field is left empty", async () => {
    api.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/v1/personas")) return { personas: PERSONAS };
      if (path.includes("/launch-review")) return { ok: true };
      if (path.includes("/review-agent-type")) return { agent };
      return { models: { claude: [{ id: "opus", label: "Opus" }] } };
    });
    renderLauncher();

    fireEvent.click(await screen.findByTestId("launch-reviewer-button"));
    fireEvent.click(
      await screen.findByTestId("launch-reviewer-persona-ux-review")
    );

    await vi.waitFor(() =>
      expect(screen.getByTestId("launch-reviewer-submit")).toHaveProperty(
        "disabled",
        false
      )
    );
    fireEvent.click(screen.getByTestId("launch-reviewer-submit"));

    await vi.waitFor(() => {
      const call = api.mock.calls.find((args) =>
        String(args[0]).includes("/launch-review")
      );
      expect(call).toBeDefined();
      expect(JSON.parse(call![1].body).note).toBeNull();
    });
  });
});
