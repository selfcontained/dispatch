// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ResponsePlaceholder } from "./response-placeholder";
import type { Step } from "./contracts";
afterEach(cleanup);
it("acknowledges nested calls without replaying the piece on status changes", () => {
  const parent: Step = {
    id: "parent",
    kind: "execute",
    label: "outer",
    status: "running",
    startedAt: 0,
  };
  const child: Step = {
    id: "child",
    kind: "read",
    label: "nested read",
    status: "running",
    startedAt: 1,
  };
  const view = render(
    <ResponsePlaceholder seed="nested-test" steps={[parent]} />
  );
  expect(view.getAllByTestId("chat-response-placeholder-block")).toHaveLength(
    1
  );
  view.rerender(
    <ResponsePlaceholder
      seed="nested-test"
      steps={[{ ...parent, children: [child] }]}
    />
  );
  expect(view.getAllByTestId("chat-response-placeholder-block")).toHaveLength(
    2
  );
  const block = view.getByTitle("nested read");
  const acknowledgement = block.firstElementChild;
  expect(acknowledgement?.classList.contains("dispatch-defrag-ack")).toBe(true);
  view.rerender(
    <ResponsePlaceholder
      seed="nested-test"
      steps={[
        { ...parent, children: [{ ...child, status: "ok", endedAt: 2 }] },
      ]}
    />
  );
  expect(view.getAllByTestId("chat-response-placeholder-block")).toHaveLength(
    2
  );
  expect(view.getByTitle("nested read").firstElementChild).toBe(
    acknowledgement
  );
});
