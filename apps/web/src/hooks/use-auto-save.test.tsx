// @vitest-environment jsdom
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { Input } from "@/components/ui/input";
import { SettingRow } from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";
import { SAVED_NOTE_MS, useAutoSave } from "./use-auto-save";
import { useTextSetting } from "./use-text-setting";

const write = vi.fn<(value: unknown) => Promise<void>>();

beforeEach(() => write.mockReset().mockResolvedValue(undefined));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Toggle() {
  const [saved, setSaved] = useState(false);
  const autoSave = useAutoSave<boolean, "on">(async (_, on) => {
    await write(on);
    setSaved(on);
  });
  return (
    <SettingRow label="Enabled" status={autoSave.status("on")}>
      <Switch
        checked={autoSave.value("on", saved)}
        onCheckedChange={(on) => void autoSave.save("on", on)}
      />
    </SettingRow>
  );
}

function Text() {
  const [saved, setSaved] = useState("Old");
  const autoSave = useAutoSave<string, "name">(async (_, name) => {
    await write(name);
    setSaved(name);
  });
  const field = useTextSetting({
    name: "name",
    saved,
    autoSave,
    validate: (value) => (value ? undefined : "Enter a name."),
  });
  return (
    <SettingRow
      layout="field"
      label="Name"
      status={field.status}
      error={field.problem}
    >
      <Input {...field.inputProps} />
    </SettingRow>
  );
}

const settle = () => act(async () => {});
const toggle = () => screen.getByRole("switch", { name: "Enabled" });
const text = () => screen.getByLabelText("Name") as HTMLInputElement;
function edit(value: string) {
  fireEvent.change(text(), { target: { value } });
  fireEvent.blur(text());
}
function failed() {
  return screen.queryByText("Couldn’t save changes.");
}
const retry = () =>
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));

it("shows Saved once the server confirms, briefly", async () => {
  vi.useFakeTimers();
  let confirm!: () => void;
  write.mockReturnValueOnce(new Promise((resolve) => (confirm = resolve)));
  render(<Toggle />);

  fireEvent.click(toggle());
  await settle();
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  expect(screen.queryByText("Saved")).toBeNull();

  confirm();
  await settle();
  expect(screen.getByText("Saved")).toBeTruthy();

  act(() => void vi.advanceTimersByTime(SAVED_NOTE_MS));
  expect(screen.queryByText("Saved")).toBeNull();
  expect(toggle().getAttribute("aria-checked")).toBe("true");
});

it("rolls a failed toggle back and retries the value intended", async () => {
  write.mockRejectedValueOnce(new Error("offline"));
  render(<Toggle />);

  fireEvent.click(toggle());
  await settle();
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  expect(failed()).toBeTruthy();

  retry();
  await settle();
  expect(write).toHaveBeenLastCalledWith(true);
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  expect(failed()).toBeNull();
});

it("saves text on blur, and nothing unchanged", async () => {
  render(<Text />);
  edit("Old");
  expect(write).not.toHaveBeenCalled();
  edit("  New  ");
  await settle();
  expect(write).toHaveBeenCalledWith("New");
  expect(text().value).toBe("New");
});

it("keeps a failed edit, and retries what is in the field now", async () => {
  write.mockRejectedValueOnce(new Error("offline"));
  render(<Text />);
  edit("New");
  await settle();
  expect(text().value).toBe("New");
  expect(text().getAttribute("aria-invalid")).toBe("true");

  fireEvent.change(text(), { target: { value: "Newer" } });
  retry();
  await settle();
  expect(write).toHaveBeenLastCalledWith("Newer");
  expect(text().value).toBe("Newer");
  expect(failed()).toBeNull();
});

it("keeps an edit blurred again while the save that will fail is in flight", async () => {
  let refuse!: (error: Error) => void;
  write.mockReturnValueOnce(new Promise((_, reject) => (refuse = reject)));
  render(<Text />);
  edit("New");
  await settle();
  fireEvent.blur(text());

  refuse(new Error("offline"));
  await settle();
  expect(write).toHaveBeenCalledTimes(1);
  expect(text().value).toBe("New");
});

it("clears the failure when the edit goes back to what is saved", async () => {
  write.mockRejectedValueOnce(new Error("offline"));
  render(<Text />);
  edit("New");
  await settle();
  edit("Old");
  await settle();
  expect(failed()).toBeNull();
  expect(write).toHaveBeenCalledTimes(1);
});

it("doesn't send an edit that doesn't validate", () => {
  render(<Text />);
  edit("");
  expect(write).not.toHaveBeenCalled();
  expect(screen.getByText("Enter a name.")).toBeTruthy();
});
