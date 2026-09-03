// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AssistedUpdateMetadata } from "@/hooks/use-release-stream";

import { AssistedUpdateGate } from "./assisted-update-gate";

// Markdown pulls in react-markdown and lazily boots mermaid off a live
// CSSStyleDeclaration; the gate only uses it as a body renderer, and the
// behaviour under test is the disclosure toggle around it.
vi.mock("@/components/ui/markdown", () => ({
  Markdown: ({ children }: { children: string }) => <div>{children}</div>,
}));

afterEach(() => {
  cleanup();
});

describe("the pre-launch gates", () => {
  // `required` is NOT metadata.mode — release-info raises assistedRequired for
  // pending migrations and for an unevaluable migration set too, so a
  // mode="required" release can still be offered as merely recommended. Holding
  // the mode fixed is what proves the prop, not the metadata, drives the copy.
  it("takes the required/recommended split from the prop, not the mode", () => {
    const metadata: AssistedUpdateMetadata = {
      mode: "required",
      title: "Service manager rewrite",
      summary: "The launchd plist changes shape.",
      requiredChecks: [],
    };
    const { unmount } = render(
      <AssistedUpdateGate tag="v1.1.0" metadata={metadata} required />
    );
    expect(screen.getByText("Agent-assisted update required")).toBeTruthy();

    unmount();
    render(
      <AssistedUpdateGate tag="v1.1.0" metadata={metadata} required={false} />
    );
    expect(screen.getByText("Agent-assisted update recommended")).toBeTruthy();
    expect(screen.queryByText("Agent-assisted update required")).toBeNull();
  });

  it("accepts required checks named as bare strings or as objects", () => {
    render(
      <AssistedUpdateGate
        tag="v1.1.0"
        required
        metadata={
          {
            mode: "required",
            title: "Service manager rewrite",
            summary: "The launchd plist changes shape.",
            requiredChecks: [
              "server_responds",
              { name: "plist_shape", description: "plist is the new shape" },
            ],
          } as unknown as AssistedUpdateMetadata
        }
      />
    );

    expect(screen.getByText("server_responds")).toBeTruthy();
    expect(screen.getByText("plist_shape")).toBeTruthy();
  });

  it("opens the instructions and keeps rollback guidance folded away", () => {
    render(
      <AssistedUpdateGate
        tag="v1.1.0"
        required
        metadata={
          {
            mode: "required",
            title: "Service manager rewrite",
            summary: "The launchd plist changes shape.",
            requiredChecks: [],
            instructions: "Run the installer, then restart.",
            rollbackGuidance: "Reinstall the previous tarball.",
          } as unknown as AssistedUpdateMetadata
        }
      />
    );

    expect(screen.getByText("Run the installer, then restart.")).toBeTruthy();
    expect(screen.queryByText("Reinstall the previous tarball.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Rollback guidance/ }));
    expect(screen.getByText("Reinstall the previous tarball.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Instructions/ }));
    expect(screen.queryByText("Run the installer, then restart.")).toBeNull();
  });

  it("offers no disclosure for guidance the release did not declare", () => {
    render(
      <AssistedUpdateGate
        tag="v1.1.0"
        required
        metadata={{
          mode: "required",
          title: "Service manager rewrite",
          summary: "The launchd plist changes shape.",
          requiredChecks: [],
        }}
      />
    );

    expect(screen.queryByRole("button", { name: /Instructions/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Rollback guidance/ })
    ).toBeNull();
    expect(screen.queryByText("Required checks")).toBeNull();
  });
});
