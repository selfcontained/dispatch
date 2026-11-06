// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentEffortSelect } from "./agent-effort-select";
const choices = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-agent-model-catalog", () => ({
  useAgentEffortChoices: choices,
}));
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});
afterEach(cleanup);
describe("AgentEffortSelect", () => {
  it("uses engine values and labels, including new levels, and allows inheritance", async () => {
    choices.mockReturnValue([{ value: "future", name: "Deliberate" }]);
    const onChange = vi.fn();
    const { rerender } = render(
      <AgentEffortSelect
        value={null}
        onChange={onChange}
        agentType="codex"
        model="new-model"
      />
    );
    expect(choices).toHaveBeenCalledWith("codex", "new-model");
    fireEvent.click(screen.getByRole("button", { name: /^Effort:/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Deliberate" }));
    expect(onChange).toHaveBeenCalledWith("future");
    await waitFor(() =>
      expect(screen.queryByRole("radio", { name: "Deliberate" })).toBeNull()
    );
    rerender(
      <AgentEffortSelect value="future" onChange={onChange} agentType="codex" />
    );
    fireEvent.click(screen.getByRole("button", { name: /^Effort:/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Default" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
  it.each([undefined, []])(
    "does not fabricate options when capabilities are %s",
    (value) => {
      choices.mockReturnValue(value);
      render(
        <AgentEffortSelect
          value={null}
          onChange={vi.fn()}
          agentType="opencode"
        />
      );
      fireEvent.click(screen.getByRole("button", { name: /^Effort:/ }));
      expect(screen.getAllByRole("radio")).toHaveLength(1);
      expect(screen.getByRole("radio", { name: "Default" })).toBeTruthy();
    }
  );
});
