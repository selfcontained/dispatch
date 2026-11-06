// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentEffortSelect } from "./agent-effort-select";

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});
afterEach(cleanup);

describe("AgentEffortSelect", () => {
  it("selects Claude xhigh and allows inheritance", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <AgentEffortSelect value={null} onChange={onChange} agentType="claude" />
    );
    fireEvent.click(screen.getByRole("button", { name: /^Effort:/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Extra high" }));
    expect(onChange).toHaveBeenCalledWith("xhigh");
    rerender(
      <AgentEffortSelect value="xhigh" onChange={onChange} agentType="claude" />
    );
    fireEvent.click(screen.getByRole("button", { name: /^Effort:/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Default" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
  it("does not offer unsupported Codex max", () => {
    render(
      <AgentEffortSelect value={null} onChange={vi.fn()} agentType="codex" />
    );
    fireEvent.click(screen.getByRole("button", { name: /^Effort:/ }));
    expect(screen.queryByRole("radio", { name: "Max" })).toBeNull();
    expect(screen.getByRole("radio", { name: "Extra high" })).toBeTruthy();
  });
  it("explains and disables OpenCode effort", () => {
    render(
      <AgentEffortSelect value={null} onChange={vi.fn()} agentType="opencode" />
    );
    expect(screen.getByRole("button", { name: /^Effort:/ })).toHaveProperty(
      "disabled",
      true
    );
    expect(
      screen.getByTitle("OpenCode does not support launch effort.")
    ).toBeTruthy();
  });
});
