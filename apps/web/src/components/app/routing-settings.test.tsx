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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RoutingSettings } from "./routing-settings";
import { api } from "@/lib/api";
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
const apiMock = vi.mocked(api);
let client: QueryClient;
let saved: {
  aiEnabled?: boolean;
  mode: string;
  modeSource: string;
  configured: boolean;
  keySource: string;
  storedKey: boolean;
};
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  saved = {
    mode: "active",
    modeSource: "settings",
    configured: true,
    keySource: "settings",
    storedKey: true,
  };
  apiMock.mockReset().mockImplementation(async (_path, init) => {
    if (init?.method === "POST") return { status: "ok" };
    if (init?.method === "PUT") {
      const body = JSON.parse(init.body as string);
      saved = {
        ...saved,
        ...(body.aiEnabled !== undefined ? { aiEnabled: body.aiEnabled } : {}),
        ...(body.mode ? { mode: body.mode } : {}),
        ...(body.steeringMode ? { steeringMode: body.steeringMode } : {}),
        ...(body.mergeRiskMode ? { mergeRiskMode: body.mergeRiskMode } : {}),
        ...(body.apiKey ? { configured: true, storedKey: true } : {}),
        ...(body.removeKey
          ? { configured: false, storedKey: false, keySource: "none" }
          : {}),
      };
    }
    return saved;
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
});
async function show() {
  render(
    <QueryClientProvider client={client}>
      <RoutingSettings />
    </QueryClientProvider>
  );
  await screen.findByRole("checkbox", { name: "Route replies automatically" });
}
const writes = () =>
  apiMock.mock.calls
    .filter(([, init]) => init?.method === "PUT")
    .map(([, init]) => JSON.parse(init!.body as string));
it("uses a checkbox and a masked DB token with inline edit and cancel", async () => {
  await show();
  expect(
    screen
      .getByRole("checkbox", { name: "Route replies automatically" })
      .getAttribute("aria-checked")
  ).toBe("true");
  const masked = screen.getByLabelText(
    "OpenAI API key is set"
  ) as HTMLInputElement;
  expect(masked.readOnly).toBe(true);
  expect(masked.value).toMatch(/^•+$/);
  expect(screen.queryByRole("combobox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit OpenAI API key" }));
  const input = screen.getByLabelText("OpenAI API key") as HTMLInputElement;
  expect(input.type).toBe("password");
  expect(input.value).toBe("");
  expect(screen.queryByRole("button", { name: "Test connection" })).toBeNull();
  fireEvent.change(input, { target: { value: "discarded-test-token" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel key edit" }));
  expect(screen.getByLabelText("OpenAI API key is set")).toBeTruthy();
  expect(writes()).toEqual([]);
});
it("toggles active/off without changing the token", async () => {
  await show();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Route replies automatically" })
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("checkbox", { name: "Route replies automatically" })
        .getAttribute("aria-checked")
    ).toBe("false")
  );
  expect(writes()).toEqual([{ mode: "off" }]);
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Route replies automatically" })
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("checkbox", { name: "Route replies automatically" })
        .getAttribute("aria-checked")
    ).toBe("true")
  );
  expect(writes()).toEqual([{ mode: "off" }, { mode: "active" }]);
});
it("saves the edited token and returns to masking without exposing saved token data", async () => {
  await show();
  fireEvent.click(screen.getByRole("button", { name: "Edit OpenAI API key" }));
  fireEvent.change(screen.getByLabelText("OpenAI API key"), {
    target: { value: "new-test-token-value" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Validate & save" }));
  await screen.findByLabelText("OpenAI API key is set");
  expect(writes()).toEqual([{ apiKey: "new-test-token-value" }]);
  expect(
    JSON.stringify(client.getQueryData(["routing-experiment-settings"]))
  ).not.toContain("new-test-token-value");
});
it("removes the token and turns routing off in the same request", async () => {
  await show();
  fireEvent.click(
    screen.getByRole("button", { name: "Remove OpenAI API key" })
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("checkbox", { name: "Route replies automatically" })
    ).toBeNull()
  );
  expect(writes()).toEqual([{ removeKey: true }]);
});
it("keeps enablement disabled until an unconfigured token is saved", async () => {
  saved = {
    ...saved,
    aiEnabled: true,
    mode: "off",
    configured: false,
    storedKey: false,
  };
  await show();
  expect(
    (
      screen.getByRole("checkbox", {
        name: "Route replies automatically",
      }) as HTMLButtonElement
    ).disabled
  ).toBe(true);
  expect(
    (
      screen.getByRole("button", {
        name: "Validate & save",
      }) as HTMLButtonElement
    ).disabled
  ).toBe(true);
  expect(
    (screen.getByLabelText("OpenAI API key") as HTMLInputElement).type
  ).toBe("password");
});
it.each([
  { status: "ok", label: "Connection successful" },
  { status: "provider_error", label: "Connection failed — test again" },
])(
  "shows $label temporarily in the token heading without replacing the Test button",
  async ({ status, label }) => {
    await show();
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    apiMock.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    const test = screen.getByRole("button", { name: "Test connection" });
    fireEvent.click(test);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByLabelText("Testing connection")).toBeTruthy();
    expect(test.textContent).toBe("Test");
    expect((test as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      resolve({ status });
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByLabelText(label)).toBeTruthy();
    expect(test.textContent).toBe("Test");
    expect(
      apiMock.mock.calls.filter(([, init]) => init?.method === "POST")
    ).toHaveLength(1);
  }
);
it("keeps a failed token edit visible for correction", async () => {
  await show();
  fireEvent.click(screen.getByRole("button", { name: "Edit OpenAI API key" }));
  fireEvent.change(screen.getByLabelText("OpenAI API key"), {
    target: { value: "unsaved-test-token" },
  });
  apiMock.mockRejectedValueOnce(new Error("write failed"));
  fireEvent.click(screen.getByRole("button", { name: "Validate & save" }));
  await screen.findByRole("alert");
  expect(
    (screen.getByLabelText("OpenAI API key") as HTMLInputElement).value
  ).toBe("unsaved-test-token");
});

it("supports Escape to discard and Enter to save a token edit", async () => {
  await show();
  fireEvent.click(screen.getByRole("button", { name: "Edit OpenAI API key" }));
  fireEvent.change(screen.getByLabelText("OpenAI API key"), {
    target: { value: "discard-test-token" },
  });
  fireEvent.keyDown(screen.getByLabelText("OpenAI API key"), { key: "Escape" });
  expect(screen.getByLabelText("OpenAI API key is set")).toBeTruthy();
  expect(writes()).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Edit OpenAI API key" }));
  expect(
    (screen.getByLabelText("OpenAI API key") as HTMLInputElement).value
  ).toBe("");
  fireEvent.change(screen.getByLabelText("OpenAI API key"), {
    target: { value: "keyboard-test-token" },
  });
  fireEvent.keyDown(screen.getByLabelText("OpenAI API key"), { key: "Enter" });
  await screen.findByLabelText("OpenAI API key is set");
  expect(writes()).toEqual([{ apiKey: "keyboard-test-token" }]);
});

it("toggles steering independently of reply routing", async () => {
  await show();
  const steering = screen.getByRole("checkbox", {
    name: "Smart steering",
  });
  fireEvent.click(steering);
  await waitFor(() =>
    expect(steering.getAttribute("aria-checked")).toBe("true")
  );
  expect(writes().at(-1)).toEqual({ steeringMode: "active" });
  expect(
    screen
      .getByRole("checkbox", { name: "Route replies automatically" })
      .getAttribute("aria-checked")
  ).toBe("true");
  fireEvent.click(steering);
  await waitFor(() =>
    expect(steering.getAttribute("aria-checked")).toBe("false")
  );
});

it("uses one validation/save action while editing", async () => {
  await show();
  fireEvent.click(screen.getByRole("button", { name: "Edit OpenAI API key" }));
  expect(screen.queryByRole("button", { name: "Test connection" })).toBeNull();
  fireEvent.change(screen.getByLabelText("OpenAI API key"), {
    target: { value: "controlled-candidate" },
  });
  let resolve!: (value: unknown) => void;
  apiMock.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      })
  );
  fireEvent.click(screen.getByRole("button", { name: "Validate & save" }));
  await waitFor(() =>
    expect(
      (screen.getByLabelText("OpenAI API key") as HTMLInputElement).disabled
    ).toBe(true)
  );
  await act(async () => resolve(saved));
  await screen.findByLabelText("OpenAI API key is set");
  expect(writes()).toEqual([{ apiKey: "controlled-candidate" }]);
});

it("shows a green success check after validation/save and clears it on edit", async () => {
  await show();
  fireEvent.click(screen.getByRole("button", { name: "Edit OpenAI API key" }));
  fireEvent.change(screen.getByLabelText("OpenAI API key"), {
    target: { value: "controlled-candidate" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Validate & save" }));
  await screen.findByText("OpenAI API key validated and saved.");
  expect(
    screen.getByLabelText("Connection successful").getAttribute("class")
  ).toContain("text-green-600");
  fireEvent.click(screen.getByRole("button", { name: "Edit OpenAI API key" }));
  expect(screen.queryByText("OpenAI API key validated and saved.")).toBeNull();
  expect(screen.queryByLabelText("Connection successful")).toBeNull();
});

it("toggles merge risk assessment on its own setting", async () => {
  await show();
  const mergeRisk = screen.getByRole("checkbox", {
    name: "Merge risk assessment",
  });
  expect(mergeRisk.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(mergeRisk);
  await waitFor(() =>
    expect(mergeRisk.getAttribute("aria-checked")).toBe("true")
  );
  expect(writes().at(-1)).toEqual({ mergeRiskMode: "active" });
  expect(
    screen
      .getByRole("checkbox", { name: "Smart steering" })
      .getAttribute("aria-checked")
  ).toBe("false");
});

it("hides setup until opt-in and retains configured preferences on re-enable", async () => {
  saved = { ...saved, aiEnabled: false };
  render(
    <QueryClientProvider client={client}>
      <RoutingSettings />
    </QueryClientProvider>
  );
  const master = await screen.findByRole("switch", {
    name: "Enable Dispatch AI",
  });
  expect(screen.queryByLabelText("OpenAI API key is set")).toBeNull();
  fireEvent.click(master);
  await screen.findByLabelText("OpenAI API key is set");
  expect(writes()).toEqual([{ aiEnabled: true }]);
  fireEvent.click(master);
  await waitFor(() =>
    expect(screen.queryByLabelText("OpenAI API key is set")).toBeNull()
  );
  expect(writes().at(-1)).toEqual({ aiEnabled: false });
});

it("removes a saved key while AI stays off without enabling any features", async () => {
  saved = { ...saved, aiEnabled: false };
  render(
    <QueryClientProvider client={client}>
      <RoutingSettings />
    </QueryClientProvider>
  );
  const remove = await screen.findByRole("button", {
    name: "Remove OpenAI API key",
  });
  expect(
    screen
      .getByRole("switch", { name: "Enable Dispatch AI" })
      .getAttribute("aria-checked")
  ).toBe("false");
  fireEvent.click(remove);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Remove OpenAI API key" })
    ).toBeNull()
  );
  expect(writes()).toEqual([{ removeKey: true }]);
  expect(
    screen
      .getByRole("switch", { name: "Enable Dispatch AI" })
      .getAttribute("aria-checked")
  ).toBe("false");
  expect(screen.queryByRole("checkbox")).toBeNull();
});
