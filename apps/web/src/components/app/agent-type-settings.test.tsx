// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentTypeSettings } from "./agent-type-settings";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockResolvedValue({
    enabledAgentTypes: ["claude", "codex", "terminal"],
  });
});

afterEach(() => {
  cleanup();
});

describe("AgentTypeSettings", () => {
  it("offers every CLI type and the terminal", async () => {
    render(
      <AgentTypeSettings enabledAgentTypes={["claude"]} onChange={vi.fn()} />
    );

    await waitFor(() =>
      expect(screen.getByTestId("agent-type-toggle-claude")).not.toBeNull()
    );
    for (const type of ["codex", "cursor", "opencode", "terminal"]) {
      expect(screen.getByTestId(`agent-type-toggle-${type}`)).not.toBeNull();
    }
  });

  // The Dispatch Harness has its own card. A checkbox here would be a second
  // switch, and its POST would be refused by the server.
  it("does not offer the harness", async () => {
    render(
      <AgentTypeSettings enabledAgentTypes={["claude"]} onChange={vi.fn()} />
    );

    await waitFor(() =>
      expect(screen.getByTestId("agent-type-toggle-claude")).not.toBeNull()
    );
    expect(screen.queryByTestId("agent-type-toggle-dispatch")).toBeNull();
    expect(screen.queryByText(/Dispatch's own view over/)).toBeNull();
  });
});
