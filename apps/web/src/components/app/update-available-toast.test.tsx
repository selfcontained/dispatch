// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const { info, dismiss, reloadApp } = vi.hoisted(() => ({
  info: vi.fn<
    (
      message: string,
      options: {
        action: { label: string; onClick: () => void };
        onDismiss: () => void;
      }
    ) => void
  >(),
  dismiss: vi.fn(),
  reloadApp: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { info, dismiss } }));
vi.mock("@/lib/pwa-update", () => ({ reloadApp }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("keeps main's toast and reload behavior while notifying Health of newer versions", async () => {
  const { UpdateAvailableToast } = await import("./update-available-toast");
  const { BUILD_VERSION, noteServerVersion, subscribeServerVersion } =
    await import("@/lib/version");
  const refresh = vi.fn();
  const unsubscribe = subscribeServerVersion(refresh);
  const view = render(<UpdateAvailableToast />);
  act(() => noteServerVersion(BUILD_VERSION));
  expect(info).not.toHaveBeenCalled();

  act(() => noteServerVersion("1.0.1"));
  expect(info).toHaveBeenCalledTimes(1);
  const [message, options] = info.mock.calls[0];
  expect(message).toBe("Server updated to 1.0.1. Reload to pick it up.");
  expect(options.action.label).toBe("Reload");

  act(() => noteServerVersion("1.0.2"));
  act(() => noteServerVersion("1.0.2"));
  expect(info).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledTimes(2);

  options.action.onClick();
  options.action.onClick();
  expect(reloadApp).toHaveBeenCalledTimes(1);
  act(options.onDismiss);
  view.unmount();
  render(<UpdateAvailableToast />);
  expect(info).toHaveBeenCalledTimes(1);
  unsubscribe();
});
