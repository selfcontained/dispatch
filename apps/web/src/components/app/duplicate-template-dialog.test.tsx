// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Template } from "@/hooks/use-templates";
import { DuplicateTemplateDialog } from "./duplicate-template-dialog";
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
import { api } from "@/lib/api";
const apiMock = vi.mocked(api);
const template = { id: "source", name: "Saved source" } as Template;
function Location() {
  return <p data-testid="location">{useLocation().pathname}</p>;
}
function setup() {
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <DuplicateTemplateDialog
          template={template}
          open
          onOpenChange={onOpenChange}
        />
        <Location />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return onOpenChange;
}
afterEach(cleanup);
beforeEach(() => {
  apiMock.mockReset();
});
it("requires a trimmed name and cancels without creating anything", async () => {
  const close = setup();
  fireEvent.change(screen.getByLabelText("New template name"), {
    target: { value: "   " },
  });
  expect(
    (
      screen.getByRole("button", {
        name: "Create template",
      }) as HTMLButtonElement
    ).disabled
  ).toBe(true);
  fireEvent.submit(
    screen.getByRole("button", { name: "Create template" }).closest("form")!
  );
  await act(async () => {});
  expect(apiMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalledWith(false);
  expect(apiMock).not.toHaveBeenCalled();
});
it("sends only name and source identity once, then opens the new template", async () => {
  let resolve!: (value: unknown) => void;
  apiMock.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }) as never
  );
  const close = setup();
  fireEvent.change(screen.getByLabelText("New template name"), {
    target: { value: "  My copy  " },
  });
  const form = screen
    .getByRole("button", { name: "Create template" })
    .closest("form")!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
  expect(apiMock).toHaveBeenCalledWith("/api/v1/templates/source/duplicate", {
    method: "POST",
    body: JSON.stringify({ name: "My copy" }),
  });
  await act(async () => resolve({ id: "copy", name: "My copy" }));
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  expect(screen.getByTestId("location").textContent).toBe(
    "/automations/templates/copy"
  );
});
it("keeps name and dialog on failure and permits retry", async () => {
  apiMock.mockRejectedValueOnce(new Error("already exists"));
  const close = setup();
  fireEvent.change(screen.getByLabelText("New template name"), {
    target: { value: "My copy" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create template" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe("already exists")
  );
  expect(close).not.toHaveBeenCalled();
  expect(
    (screen.getByLabelText("New template name") as HTMLInputElement).value
  ).toBe("My copy");
  apiMock.mockResolvedValueOnce({ id: "copy", name: "My copy" });
  fireEvent.click(screen.getByRole("button", { name: "Create template" }));
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  expect(apiMock).toHaveBeenCalledTimes(2);
});
