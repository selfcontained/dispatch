// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoutingSettings } from "./routing-settings";
import { api } from "@/lib/api";
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
const apiMock = vi.mocked(api);
type Status = {
  mode: string;
  modeSource: string;
  configured: boolean;
  keySource: string;
  storedKey: boolean;
  dailyCap: number;
};
let client: QueryClient;
let saved: Status;
let requests: {
  body: { mode?: string; apiKey?: string };
  complete: () => void;
}[];
const input = () => screen.getByLabelText("API key") as HTMLInputElement;
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  saved = {
    mode: "off",
    modeSource: "settings",
    configured: false,
    keySource: "none",
    storedKey: false,
    dailyCap: 25,
  };
  requests = [];
  apiMock.mockReset().mockImplementation(async (_path, init) => {
    if (init?.method !== "PUT") return saved;
    const body = JSON.parse(init.body as string) as {
      mode?: string;
      apiKey?: string;
    };
    return new Promise((resolve) => {
      requests.push({
        body,
        complete: () => {
          saved = {
            ...saved,
            ...(body.mode ? { mode: body.mode } : {}),
            ...(body.apiKey
              ? { configured: true, keySource: "settings", storedKey: true }
              : {}),
          };
          resolve(saved);
        },
      });
    });
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  client.clear();
});
async function show() {
  render(
    <QueryClientProvider client={client}>
      <RoutingSettings />
    </QueryClientProvider>
  );
  await screen.findByLabelText("API key");
}
async function finish() {
  await act(async () => {
    requests[0]!.complete();
  });
  await screen.findByText("Saved", { exact: true });
}
describe("RoutingSettings in-flight drafts", () => {
  it("preserves a key typed while a mode-only mutation is pending", async () => {
    await show();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Mode" }), {
      key: "ArrowDown",
    });
    fireEvent.click(await screen.findByRole("option", { name: "Shadow" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.body).toEqual({ mode: "shadow" });
    fireEvent.change(input(), {
      target: { value: "new-draft-during-mode-save" },
    });
    await finish();
    expect(input().value).toBe("new-draft-during-mode-save");
  });
  it("preserves a newer draft when an older key-save request completes", async () => {
    await show();
    fireEvent.change(input(), { target: { value: "original-submitted-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.body).toEqual({ apiKey: "original-submitted-key" });
    fireEvent.change(input(), { target: { value: "newer-unsaved-key" } });
    await finish();
    expect(input().value).toBe("newer-unsaved-key");
  });
  it("clears a saved key when the current draft still matches that submission", async () => {
    await show();
    fireEvent.change(input(), { target: { value: "same-submitted-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    await finish();
    expect(input().value).toBe("");
    expect(screen.getByText("Configured", { exact: true })).toBeTruthy();
  });
});
