import { describe, expect, it } from "vitest";

import {
  initialPopupState,
  reducePopupState,
  type PopupEvent,
  type PopupState,
} from "./popup-state";

function reduceAll(events: PopupEvent[], from: PopupState = initialPopupState) {
  return events.reduce(reducePopupState, from);
}

describe("reducePopupState", () => {
  it("lands on disconnected when nothing is pending or connected", () => {
    const state = reduceAll([
      {
        type: "status",
        pairing: { state: "idle" },
        connection: { connected: false },
      },
    ]);
    expect(state.view).toBe("disconnected");
  });

  it("resumes a pending pairing on reopen — the popup died when the verification tab opened", () => {
    const state = reduceAll([
      {
        type: "status",
        pairing: {
          state: "pending",
          baseUrl: "http://dispatch.test",
          code: "123456",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        connection: { connected: false },
      },
    ]);
    expect(state).toMatchObject({ view: "pairing", code: "123456" });
  });

  it("shows connected with a success notice when approval happened while closed", () => {
    const state = reduceAll([
      {
        type: "status",
        pairing: { state: "approved", baseUrl: "http://dispatch.test" },
        connection: { connected: true, baseUrl: "http://dispatch.test" },
      },
    ]);
    expect(state).toMatchObject({ view: "connected", justPaired: true });
  });

  it("surfaces pairing expiry as an error on the connect form", () => {
    const state = reduceAll([
      {
        type: "status",
        pairing: { state: "expired" },
        connection: { connected: false },
      },
    ]);
    expect(state).toMatchObject({
      view: "disconnected",
      error: "The pairing request expired. Try again.",
    });
  });

  it("requires an explicit second connect for insecure HTTP", () => {
    const disconnected = reduceAll([
      {
        type: "status",
        pairing: { state: "idle" },
        connection: { connected: false },
      },
      { type: "insecure-warning", baseUrl: "http://dispatch.test" },
    ]);
    expect(disconnected).toMatchObject({
      view: "disconnected",
      insecureWarning: true,
      insecureAcknowledgedFor: "http://dispatch.test",
    });
  });

  it("routes a no-site-access arm failure to the guidance view and back on retry", () => {
    const connected: PopupState = {
      view: "connected",
      baseUrl: "http://dispatch.test",
      justPaired: false,
      arming: false,
      error: null,
    };
    const denied = reduceAll(
      [
        { type: "arm-started" },
        {
          type: "arm-failed",
          code: "no-site-access",
          error: "Dispatch Feedback is not allowed on this website yet.",
        },
      ],
      connected
    );
    expect(denied).toMatchObject({
      view: "needs-site-access",
      baseUrl: "http://dispatch.test",
    });

    const retried = reducePopupState(denied, { type: "site-access-retry" });
    expect(retried).toMatchObject({ view: "connected", arming: false });
  });

  it("keeps other arm failures on the connected view with an error", () => {
    const connected: PopupState = {
      view: "connected",
      baseUrl: "http://dispatch.test",
      justPaired: false,
      arming: true,
      error: null,
    };
    const failed = reducePopupState(connected, {
      type: "arm-failed",
      code: "unsupported-page",
      error: "This page cannot be inspected.",
    });
    expect(failed).toMatchObject({
      view: "connected",
      arming: false,
      error: "This page cannot be inspected.",
    });
  });

  it("does not let a background status refresh clobber an in-flight arm", () => {
    const arming: PopupState = {
      view: "connected",
      baseUrl: "http://dispatch.test",
      justPaired: false,
      arming: true,
      error: null,
    };
    const refreshed = reducePopupState(arming, {
      type: "status",
      pairing: { state: "idle" },
      connection: { connected: true, baseUrl: "http://dispatch.test" },
    });
    expect(refreshed).toBe(arming);
  });

  it("moves to armed after a successful arm", () => {
    const connected: PopupState = {
      view: "connected",
      baseUrl: "http://dispatch.test",
      justPaired: false,
      arming: true,
      error: null,
    };
    expect(reducePopupState(connected, { type: "arm-succeeded" })).toEqual({
      view: "armed",
      baseUrl: "http://dispatch.test",
    });
  });
});
