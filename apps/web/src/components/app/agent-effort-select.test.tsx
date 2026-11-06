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
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "xhigh" }));
    expect(onChange).toHaveBeenCalledWith("xhigh");
    rerender(
      <AgentEffortSelect value="xhigh" onChange={onChange} agentType="claude" />
    );
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "Default" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
  it("does not offer unsupported Codex max", () => {
    render(
      <AgentEffortSelect value={null} onChange={vi.fn()} agentType="codex" />
    );
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(screen.queryByRole("option", { name: "max" })).toBeNull();
    expect(screen.getByRole("option", { name: "xhigh" })).toBeTruthy();
  });
  it("explains and disables OpenCode effort", () => {
    render(
      <AgentEffortSelect value={null} onChange={vi.fn()} agentType="opencode" />
    );
    expect(screen.getByRole("combobox")).toHaveProperty("disabled", true);
    expect(
      screen.getByTitle("OpenCode does not support launch effort.")
    ).toBeTruthy();
  });
});
