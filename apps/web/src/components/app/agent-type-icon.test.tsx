// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentTypeIcon } from "./agent-type-icon";

vi.mock("@/hooks/use-icon-color", () => ({
  useIconColor: () => ({ iconColor: "teal" }),
}));

describe("AgentTypeIcon for the Dispatch Harness", () => {
  it("wears the harness icon in the chosen color", () => {
    render(<AgentTypeIcon type="dispatch" />);
    const img = screen.getByLabelText("Dispatch agent").querySelector("img");
    expect(img?.getAttribute("src")).toBe("/icons/teal/harness-icon.svg");
  });
});
