import { describe, expect, it, vi } from "vitest";
import {
  imageMimeType,
  isImageFile,
} from "../../../packages/runner/src/workload/shared/git/diff-image.js";
import {
  WorkspaceError,
  workspaceViewError,
} from "../../../packages/runner/src/workload/files/workspace-view.js";
import { observeBoundCheckout } from "../src/agents/checkout-observation.js";
import { HumanTerminalManager } from "../src/terminal/manager.js";

describe("checkout view helper parity", () => {
  it("keeps main's exact raster MIME extension rules", () => {
    expect(
      [
        "a.PNG",
        "a.jpeg",
        "a.gif",
        "a.webp",
        "a.svg",
        "a.png/",
        "toString",
        ".jpg",
      ].map(imageMimeType)
    ).toEqual([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      null,
      null,
      null,
      "image/jpeg",
    ]);
    expect(isImageFile("a.svg")).toBe(false);
  });
  it("preserves workspace error identity and exact status/message mapping", () => {
    const existing = new WorkspaceError("original", 418);
    expect(workspaceViewError(existing)).toBe(existing);
    for (const [code, status, message] of [
      ["ESTALE", 409, "Directory changed. Refresh to retry."],
      ["ENOENT", 404, "File or workspace no longer exists."],
      ["ENOTDIR", 404, "File or workspace no longer exists."],
      ["EACCES", 403, "This path cannot be read."],
      ["EPERM", 403, "This path cannot be read."],
      ["ELOOP", 403, "This path cannot be read."],
      ["other", 500, "Unable to read workspace."],
    ])
      expect(workspaceViewError({ code })).toMatchObject({ status, message });
  });
  it("preserves borrower projection ordering and references", () => {
    const borrowers = ["b", "a"];
    const result = observeBoundCheckout("a", "owner", borrowers, null);
    expect(result).toEqual({
      ownership: "borrowed",
      owner: "owner",
      borrowers: ["b", "a"],
      checkout: null,
    });
    expect(result.borrowers).toBe(borrowers);
    expect(observeBoundCheckout("a", "a", [], null).ownership).toBe("owned");
  });
  it("kills exactly once when shutdown precedes terminal opening", async () => {
    const manager = new HumanTerminalManager();
    const kill = vi.fn();
    let resolve!: (value: any) => void;
    const backend = new Promise<any>((done) => {
      resolve = done;
    });
    const opening = manager.open("owner", "client", "agent", () => backend);
    manager.shutdown();
    resolve({
      cwd: "/tmp",
      host: "host",
      user: "user",
      kill,
      terminal: { close: vi.fn() },
      exited: new Promise(() => {}),
    });
    await expect(opening).rejects.toThrow(
      "Terminal was closed before it could open."
    );
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
