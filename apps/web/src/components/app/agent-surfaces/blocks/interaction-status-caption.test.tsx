// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ActionFeedback,
  showsDisabledReason,
} from "./interaction-status-caption";
import type { InteractionCaption } from "@/components/app/agent-surfaces/interaction-presentation";

afterEach(() => {
  cleanup();
});

const QUEUED: InteractionCaption = {
  kind: "pending",
  status: "queued",
  label: "Queued",
  message: "waiting for the agent",
};

const REJECTED: InteractionCaption = {
  kind: "outcome",
  status: "rejected",
  label: "Declined",
  tone: "danger",
  message: "Not enough context.",
};

describe("showsDisabledReason", () => {
  it("is true only when there is no caption, the control is disabled, and a reason exists", () => {
    expect(showsDisabledReason(null, true, "Waiting on approval.")).toBe(true);
    expect(showsDisabledReason(null, false, "Waiting on approval.")).toBe(
      false
    );
    expect(showsDisabledReason(null, true, undefined)).toBe(false);
    expect(showsDisabledReason(QUEUED, true, "Waiting on approval.")).toBe(
      false
    );
    expect(showsDisabledReason(REJECTED, true, "Waiting on approval.")).toBe(
      false
    );
  });
});

describe("ActionFeedback", () => {
  it("renders the disabled reason when there is no interaction to report", () => {
    render(
      <ActionFeedback
        id="reason-1"
        caption={null}
        disabled
        disabledReason="Waiting on approval."
      />
    );
    const reason = screen.getByTestId("action-disabled-reason");
    expect(reason.id).toBe("reason-1");
    expect(reason.textContent).toBe("Waiting on approval.");
  });

  it("renders nothing with no caption and no reason", () => {
    const { container } = render(
      <ActionFeedback
        id="reason-2"
        caption={null}
        disabled={false}
        disabledReason={undefined}
      />
    );
    expect(container.textContent).toBe("");
  });

  it("prefers the interaction caption over the disabled reason", () => {
    render(
      <ActionFeedback
        id="reason-3"
        caption={QUEUED}
        disabled
        disabledReason="Waiting on approval."
      />
    );
    expect(screen.queryByTestId("action-disabled-reason")).toBeNull();
    expect(screen.getByTestId("interaction-status-caption").textContent).toBe(
      "Queued — waiting for the agent"
    );
  });

  it("announces pending and outcome captions politely via role=status", () => {
    render(
      <ActionFeedback
        id="r"
        caption={QUEUED}
        disabled={false}
        disabledReason={undefined}
      />
    );
    const caption = screen.getByRole("status");
    expect(caption.getAttribute("data-caption-kind")).toBe("pending");
    expect(caption.getAttribute("data-interaction-status")).toBe("queued");
  });

  it("leads with the outcome word so it is announced before the agent's explanation", () => {
    render(
      <ActionFeedback
        id="r"
        caption={REJECTED}
        disabled={false}
        disabledReason={undefined}
      />
    );
    const caption = screen.getByRole("status");
    expect(caption.textContent).toBe("Declined — Not enough context.");
    expect(caption.getAttribute("data-interaction-status")).toBe("rejected");
  });

  it("colours a declined outcome with the danger tone so a rejection reads as one", () => {
    render(
      <ActionFeedback
        id="r"
        caption={REJECTED}
        disabled={false}
        disabledReason={undefined}
      />
    );
    expect(screen.getByRole("status").className).toContain(
      "text-status-blocked"
    );
  });

  it("renders a message-less outcome as a complete sentence", () => {
    render(
      <ActionFeedback
        id="r"
        caption={{
          kind: "outcome",
          status: "completed",
          label: "Completed",
          tone: "success",
        }}
        disabled={false}
        disabledReason={undefined}
      />
    );
    expect(screen.getByRole("status").textContent).toBe("Completed.");
  });

  it("raises a failed submission as an alert, with a reload action", () => {
    const onReload = vi.fn();
    render(
      <ActionFeedback
        id="reason-4"
        caption={{ kind: "error", message: "send failed" }}
        disabled={false}
        disabledReason={undefined}
        onReload={onReload}
      />
    );
    expect(screen.getByRole("alert").textContent).toContain("send failed");
    screen.getByRole("button", { name: /Reload/ }).click();
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
