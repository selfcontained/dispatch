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
  expect(screen.getByText("text")).toBeTruthy();
  expect(screen.getByText(/Shared by Coordinator/)).toBeTruthy();
  expect(screen.getByText("User")).toBeTruthy();
  expect(screen.getByText("Approve only this task?")).toBeTruthy();
  expect(screen.getByText("Yes", { selector: "p" })).toBeTruthy();
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

it("renders a review summary as safe Markdown without serializing arbitrary payloads", () => {
  const { container } = render(
    <SharedMessageEntry
      share={{
        ...share,
        question: null,
        message: {
          text: "",
          kind: "review",
          attachments: [],
          data: {
            summary:
              "**Readable review** [proof](https://example.com/proof) [bad](javascript:alert(1)) <script>alert(1)</script> ![remote](https://example.com/tracker.png)",
            secret: "DO NOT DISPLAY",
          },
        },
      }}
    />
  );
  expect(container.querySelector("strong")?.textContent).toBe(
    "Readable review"
  );
  expect(screen.getByRole("link", { name: "proof" }).getAttribute("href")).toBe(
    "https://example.com/proof"
  );
  expect(container.querySelector("script, img, input, textarea")).toBeNull();
  expect(container.querySelectorAll("a")).toHaveLength(1);
  expect(container.textContent).not.toContain("DO NOT DISPLAY");
  expect(container.textContent).not.toContain("not a new user instruction");
});

it("bounds unknown-kind content and never exposes arbitrary JSON or mutating controls", () => {
  const { container } = render(
    <SharedMessageEntry
      share={{
        ...share,
        question: null,
        message: {
          text: "x".repeat(50000),
          kind: "future" as never,
          data: { secret: "PRIVATE" },
          attachments: [],
        },
      }}
    />
  );
  expect(container.textContent!.length).toBeLessThan(14000);
  expect(screen.getByText(/Snapshot display truncated/)).toBeTruthy();
  expect(container.textContent).not.toContain("PRIVATE");
  expect(container.querySelectorAll("button")).toHaveLength(1);
});

it("renders findings and choices as inert snapshot text", () => {
  const { container } = render(
    <SharedMessageEntry
      share={{
        ...share,
        message: {
          text: "",
          kind: "finding",
          data: {
            severity: "major",
            title: "Bounded finding",
            body: "Fix **this**",
            path: "src/a.ts",
            line: 12,
          },
          attachments: [],
        },
      }}
    />
  );
  expect(screen.getByText("major · Bounded finding")).toBeTruthy();
  expect(screen.getByText("src/a.ts:12")).toBeTruthy();
  expect(container.querySelectorAll("button")).toHaveLength(1);
});

it.each(["text", "system", "turn-result", "question"])(
  "keeps %s originals readable without answer or execution controls",
  (kind) => {
    const { container } = render(
      <SharedMessageEntry
        share={{
          ...share,
          question: null,
          message: {
            text: "Original **answer**",
            kind: kind as never,
            data: { options: [{ label: "Accept" }] },
            attachments: [],
          },
        }}
      />
    );
    expect(container.querySelector("strong")?.textContent).toBe("answer");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(container.querySelector("input, textarea, iframe")).toBeNull();
  }
);

it("marks omissions when individually bounded review fields exceed the combined display cap", () => {
  render(
    <SharedMessageEntry
      share={{
        ...share,
        question: null,
        message: {
          text: "a".repeat(7000),
          kind: "review",
          data: { summary: "b".repeat(7000) },
          attachments: [],
        },
      }}
    />
  );
  expect(screen.getByText(/Snapshot display truncated/)).toBeTruthy();
});
