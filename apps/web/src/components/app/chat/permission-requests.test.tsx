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
import { afterEach, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { PermissionRequests } from "./permission-requests";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const OPTIONS = [
  { optionId: "always", name: "Always", kind: "allow_always" },
  { optionId: "once", name: "Allow once", kind: "allow_once" },
  { optionId: "no", name: "Reject", kind: "reject_once" },
];

async function show(details: string, options = OPTIONS) {
  vi.mocked(api).mockResolvedValue({
    connected: true,
    requests: [{ id: "r1", title: "Run validation", details, options }],
  });
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity } },
  });
  client.setQueryData(["agents"], [{ id: "a1", cwd: "/repo" }]);
  render(
    <QueryClientProvider client={client}>
      <PermissionRequests agentId="a1" active />
    </QueryClientProvider>
  );
  await screen.findByText("Run validation");
}

const details = (input: object) => JSON.stringify(input, null, 2);
const isOpen = () =>
  screen
    .getByRole("button", { name: "Full request" })
    .getAttribute("aria-expanded") === "true";

it("folds a routine one-line command and keeps the rest a click away", async () => {
  await show(details({ command: "pnpm run check", cwd: "/repo" }));
  expect(screen.getByTestId("permission-command").textContent).toBe(
    "pnpm run check"
  );
  expect(isOpen()).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Full request" }));
  const full = screen.getByTestId("permission-details").textContent;
  expect(full).toContain("/repo");
  expect(full).toContain('"command": "pnpm run check"');
});

it.each([
  ["a second line", details({ command: "echo ok\nrm -rf build" })],
  [
    "an option beside the command",
    details({ command: "ls", sandbox_permissions: "require_escalated" }),
  ],
  ["content after the input", `${details({ command: "ls" })}\n\n/etc/hosts`],
  ["a directory outside the workspace", details({ command: "ls", cwd: "/" })],
  ["a relative directory", details({ command: "ls", workdir: ".." })],
  ["both command keys", details({ command: "ls", cmd: "rm -rf build" })],
  [
    "both directory keys",
    details({ command: "ls", cwd: "/repo", workdir: "/" }),
  ],
  ["invisible characters", details({ command: "ls \u202e build" })],
  ["no command", details({ file_path: "/etc/hosts" })],
  ["input it can't read", '{\n  "command": "ls"\n… [truncated]'],
])("opens on %s, so it is seen before approval", async (_case, text) => {
  await show(text);
  expect(isOpen()).toBe(true);
  // Whitespace is how the pre shows it; the content is all there.
  expect(screen.getByTestId("permission-details").textContent).toContain(text);
});

it("leads with the single grant, and each choice sends its own option", async () => {
  await show(details({ command: "ls" }));
  const once = screen.getByRole("button", { name: "Allow once" });
  expect(once.className).toContain("bg-primary");
  for (const name of ["Always", "Reject"])
    expect(screen.getByRole("button", { name }).className).not.toContain(
      "bg-primary"
    );
  fireEvent.click(screen.getByRole("button", { name: "Always" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/api/v1/agents/a1/permissions/r1", {
      method: "POST",
      body: JSON.stringify({ optionId: "always" }),
    })
  );
});

it("never promotes a standing grant to the primary action", async () => {
  await show(details({ command: "ls" }), [OPTIONS[0]!]);
  expect(
    screen.getByRole("button", { name: "Always" }).className
  ).not.toContain("bg-primary");
  expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
});

it("opens when the line stops fitting after mount, and not again after a close", async () => {
  let resized = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      disconnect() {}
    }
  );
  let width = 500;
  vi.spyOn(Element.prototype, "scrollWidth", "get").mockReturnValue(400);
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(
    () => width
  );
  await show(details({ command: "pnpm run check" }));
  expect(isOpen()).toBe(false);

  width = 300;
  act(() => resized());
  expect(isOpen()).toBe(true);

  // Closing changes the width (the scrollbar goes); that must not reopen it.
  fireEvent.click(screen.getByRole("button", { name: "Full request" }));
  width = 310;
  act(() => resized());
  expect(isOpen()).toBe(false);
});
