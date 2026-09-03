// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PendingMigrationsGate } from "./pending-migrations-gate";

afterEach(() => {
  cleanup();
});

describe("the pre-launch gates", () => {
  it("counts the pending update steps", () => {
    render(
      <PendingMigrationsGate
        tag="v1.1.0"
        pendingMigrations={[
          { id: "0001", title: "Move the socket", summary: "Relocates it." },
          { id: "0002", title: "Rewrite the plist", summary: "New shape." },
        ]}
      />
    );

    expect(screen.getByText("2 complex update steps")).toBeTruthy();
    expect(screen.getByText("Move the socket")).toBeTruthy();
    expect(screen.getByText("Relocates it.")).toBeTruthy();
    expect(screen.getByText("v1.1.0")).toBeTruthy();
  });

  it("says step, singular, for one pending migration", () => {
    render(
      <PendingMigrationsGate
        tag="v1.1.0"
        pendingMigrations={[
          { id: "0001", title: "Move the socket", summary: "Relocates it." },
        ]}
      />
    );

    expect(screen.getByText("1 complex update step")).toBeTruthy();
  });
});
