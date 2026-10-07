// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { MacAppUpdateSnapshot, MacAppUpdateState } from "@dispatch/shared";

import { MacAppUpdatesCard } from "./mac-app-updates-card";

const IDLE: MacAppUpdateState = {
  version: "1.0.1",
  phase: "idle",
  availableVersion: null,
  checkedAt: null,
  error: null,
  automatic: false,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Serves `snapshot` for GET and records POSTed actions. */
function serve(snapshot: MacAppUpdateSnapshot, postStatus = 202) {
  const posted: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted.push(
          (JSON.parse(String(init.body)) as { action: string }).action
        );
        return new Response(
          JSON.stringify(
            postStatus === 202 ? { ok: true } : { error: "Mac app went away." }
          ),
          { status: postStatus }
        );
      }
      return new Response(JSON.stringify(snapshot), { status: 200 });
    })
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MacAppUpdatesCard />
    </QueryClientProvider>
  );
  return posted;
}

it("falls back to menu bar instructions when the Mac app isn't connected", async () => {
  serve({ connected: false, state: null });
  await screen.findByText(/you can also check for and install updates here/);
  expect(screen.queryByTestId("mac-app-check-button")).toBeNull();
});

it("sends a check to the Mac app", async () => {
  const posted = serve({ connected: true, state: IDLE });
  fireEvent.click(await screen.findByTestId("mac-app-check-button"));
  await waitFor(() => expect(posted).toEqual(["check"]));
});

it("installs an available update only after confirmation", async () => {
  const posted = serve({
    connected: true,
    state: { ...IDLE, availableVersion: "1.0.2" },
  });
  fireEvent.click(await screen.findByTestId("mac-app-install-button"));
  expect(posted).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Install and restart" }));
  await waitFor(() => expect(posted).toEqual(["install"]));
});

it("shows up to date after a check finds nothing", async () => {
  serve({
    connected: true,
    state: { ...IDLE, checkedAt: new Date().toISOString() },
  });
  await screen.findByText(/Up to date · checked just now/);
  expect(screen.queryByTestId("mac-app-install-button")).toBeNull();
});

it("locks the controls while installing", async () => {
  serve({
    connected: true,
    state: { ...IDLE, phase: "installing", availableVersion: "1.0.2" },
  });
  await screen.findByText(/Installing update/);
  expect(
    (screen.getByTestId("mac-app-check-button") as HTMLButtonElement).disabled
  ).toBe(true);
  expect(screen.queryByTestId("mac-app-install-button")).toBeNull();
});

it("shows a failed request's error", async () => {
  serve({ connected: true, state: IDLE }, 409);
  fireEvent.click(await screen.findByTestId("mac-app-check-button"));
  await screen.findByText("Mac app went away.");
});
