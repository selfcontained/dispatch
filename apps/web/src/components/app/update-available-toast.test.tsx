// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const { info, dismiss, reloadApp } = vi.hoisted(() => ({
  info: vi.fn<
    (
      message: string,
      options: {
        action: {
          label: string;
          onClick: (event: { preventDefault: () => void }) => void;
        };
        description: string;
        onDismiss: () => void;
      }
    ) => void
  >(),
  dismiss: vi.fn(),
  reloadApp: vi.fn(),
}));

vi.mock("@/components/ui/toast", () => ({ toast: { info, dismiss } }));
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
  expect(message).toBe("Server updated to 1.0.1.");
  expect(options.description).toBe("Reload to pick up the new version.");
  expect(options.action.label).toBe("Reload");

  act(() => noteServerVersion("1.0.2"));
  act(() => noteServerVersion("1.0.2"));
  expect(info).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledTimes(2);

  options.action.onClick({ preventDefault: vi.fn() });
  options.action.onClick({ preventDefault: vi.fn() });
  expect(reloadApp).toHaveBeenCalledTimes(1);
  act(options.onDismiss);
  view.unmount();
  render(<UpdateAvailableToast />);
  expect(info).toHaveBeenCalledTimes(1);
  unsubscribe();
});
