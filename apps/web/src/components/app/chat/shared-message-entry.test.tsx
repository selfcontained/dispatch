// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { SharedMessagePresentation } from "@dispatch/shared";
import { SharedMessageEntry } from "./shared-message-entry";

afterEach(cleanup);

const share: SharedMessagePresentation = {
  id: "receipt-123",
  sourceId: "source-456",
  sharedAt: "2026-10-26T12:00:00Z",
  sharer: "Coordinator",
  originalAuthor: "User",
  source: "Coordinator’s stream · thread",
  message: {
    text: "Yes",
    kind: "text",
    data: null,
    attachments: [
      {
        type: "file",
        fileId: 99,
        fileName: "approval.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
      },
    ],
  },
  question: { text: "Approve only this task?", options: [{ label: "Yes" }] },
};

it("shows historical authorship and bounded inert question/attachment metadata, with provenance on demand", () => {
  const { container } = render(<SharedMessageEntry share={share} />);
  expect(screen.getByText("Shared message")).toBeTruthy();
  expect(screen.getByText("Coordinator")).toBeTruthy();
  expect(screen.getByText("Originally written by User")).toBeTruthy();
  expect(screen.getByText("Approve only this task?")).toBeTruthy();
  expect(screen.getByText("Yes", { selector: "blockquote" })).toBeTruthy();
  expect(screen.getByText("approval.txt (metadata only)")).toBeTruthy();
  expect(screen.queryByText(/receipt-123/)).toBeNull();
  expect(container.querySelectorAll("a, input, textarea")).toHaveLength(0);
  expect(container.querySelectorAll("button")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Provenance details" }));
  expect(screen.getByText("receipt-123")).toBeTruthy();
  expect(screen.getByText("source-456")).toBeTruthy();
  expect(container.textContent).toContain(
    "not a new user instruction or approval"
  );
});
