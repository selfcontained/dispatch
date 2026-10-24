// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetPasswordForm } from "./set-password-form";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup() {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const onSuccess = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <SetPasswordForm onSuccess={onSuccess} />
    </QueryClientProvider>
  );
  return { invalidate, onSuccess };
}
function fill(password: string, confirm = password) {
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: password },
  });
  fireEvent.change(screen.getByLabelText("Confirm password"), {
    target: { value: confirm },
  });
}
describe("set password form", () => {
  it("requires eight characters and matching confirmation", () => {
    setup();
    const button = screen.getByRole("button", {
      name: "Set password",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fill("short");
    expect(button.disabled).toBe(true);
    fill("long-password", "different");
    expect(button.disabled).toBe(true);
    expect(screen.getByText("Passwords do not match.")).toBeTruthy();
    fill("long-password");
    expect(button.disabled).toBe(false);
  });
  it("keeps input on server failure and supports retry with cookie credentials", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "Try again." }),
      })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", fetch);
    const { onSuccess, invalidate } = setup();
    fill("long-password");
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Try again.");
    expect(onSuccess).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe(
      "long-password"
    );
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["auth-status"] });
    expect(fetch.mock.calls[1]).toEqual([
      "/api/v1/auth/setup",
      expect.objectContaining({
        credentials: "include",
        body: JSON.stringify({ password: "long-password" }),
      }),
    ]);
  });
});
