// @vitest-environment jsdom
import type { ReactNode, ButtonHTMLAttributes } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LaunchTarget } from "@/hooks/use-launch-targets";
import { RunnerPicker } from "./runner-picker";

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  SelectTrigger: ({ children }: { children?: ReactNode }) => (
    <button>{children}</button>
  ),
  SelectValue: () => null,
  SelectItem: ({
    children,
    disabled,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button disabled={disabled} {...props}>
      {children}
    </button>
  ),
}));
afterEach(cleanup);
const targets = ["online", "offline", "pending"].map((status) => ({
  key: status,
  name: status,
  status,
})) as LaunchTarget[];

it("preserves the live create picker's online-only selection", () => {
  render(<RunnerPicker targets={targets} live onChange={() => {}} />);
  expect(
    (
      screen.getByTestId(
        "create-agent-runner-option-online"
      ) as HTMLButtonElement
    ).disabled
  ).toBe(false);
  for (const status of ["offline", "pending"])
    expect(
      (
        screen.getByTestId(
          `create-agent-runner-option-${status}`
        ) as HTMLButtonElement
      ).disabled
    ).toBe(true);
});
it("allows saved automations and triggers to select offline targets", () => {
  render(<RunnerPicker targets={targets} onChange={() => {}} />);
  expect(
    (
      screen.getByTestId(
        "create-agent-runner-option-offline"
      ) as HTMLButtonElement
    ).disabled
  ).toBe(false);
});
