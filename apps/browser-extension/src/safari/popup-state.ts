import type {
  ArmFailureCode,
  ConnectionStatus,
  PairingSessionState,
} from "../types";

export type PopupState =
  | { view: "loading" }
  | {
      view: "disconnected";
      urlInput: string;
      insecureAcknowledgedFor: string | null;
      insecureWarning: boolean;
      error: string | null;
      busy: boolean;
    }
  | {
      view: "pairing";
      baseUrl: string;
      code: string;
      expiresAt: string;
      error: string | null;
    }
  | {
      view: "connected";
      baseUrl: string;
      justPaired: boolean;
      arming: boolean;
      error: string | null;
    }
  | { view: "armed"; baseUrl: string }
  | {
      view: "needs-site-access";
      baseUrl: string;
      message: string;
    };

export type PopupEvent =
  | {
      type: "status";
      pairing: PairingSessionState;
      connection: ConnectionStatus;
    }
  | { type: "status-failed"; error: string }
  | { type: "url-input"; value: string }
  | { type: "connect-invalid"; error: string }
  | { type: "insecure-warning"; baseUrl: string }
  | { type: "connect-started" }
  | {
      type: "pairing-started";
      baseUrl: string;
      code: string;
      expiresAt: string;
    }
  | { type: "pairing-failed"; error: string }
  | { type: "pairing-cancelled" }
  | { type: "disconnected" }
  | { type: "arm-started" }
  | { type: "arm-succeeded" }
  | { type: "arm-failed"; code: ArmFailureCode | undefined; error: string }
  | { type: "site-access-retry" };

export const initialPopupState: PopupState = { view: "loading" };

function disconnected(
  overrides: Partial<Extract<PopupState, { view: "disconnected" }>> = {}
): PopupState {
  return {
    view: "disconnected",
    urlInput: "",
    insecureAcknowledgedFor: null,
    insecureWarning: false,
    error: null,
    busy: false,
    ...overrides,
  };
}

export function reducePopupState(
  state: PopupState,
  event: PopupEvent
): PopupState {
  switch (event.type) {
    case "status": {
      if (event.pairing.state === "pending") {
        return {
          view: "pairing",
          baseUrl: event.pairing.baseUrl,
          code: event.pairing.code,
          expiresAt: event.pairing.expiresAt,
          error: null,
        };
      }
      if (event.pairing.state === "approved") {
        return {
          view: "connected",
          baseUrl: event.pairing.baseUrl,
          justPaired: true,
          arming: false,
          error: null,
        };
      }
      if (event.connection.connected && event.connection.baseUrl) {
        // Keep richer local context (arming, needs-site-access) when a
        // periodic status refresh lands mid-flow.
        if (
          state.view === "connected" ||
          state.view === "armed" ||
          state.view === "needs-site-access"
        ) {
          return state;
        }
        return {
          view: "connected",
          baseUrl: event.connection.baseUrl,
          justPaired: false,
          arming: false,
          error: null,
        };
      }
      if (state.view === "disconnected") {
        return event.pairing.state === "expired"
          ? { ...state, error: "The pairing request expired. Try again." }
          : state;
      }
      return disconnected({
        error:
          event.pairing.state === "expired"
            ? "The pairing request expired. Try again."
            : null,
      });
    }
    case "status-failed": {
      if (state.view === "loading") return disconnected({ error: event.error });
      return state;
    }
    case "url-input": {
      if (state.view !== "disconnected") return state;
      return {
        ...state,
        urlInput: event.value,
        insecureWarning: false,
        error: null,
      };
    }
    case "connect-invalid": {
      if (state.view !== "disconnected") return state;
      return { ...state, error: event.error, busy: false };
    }
    case "insecure-warning": {
      if (state.view !== "disconnected") return state;
      return {
        ...state,
        insecureWarning: true,
        insecureAcknowledgedFor: event.baseUrl,
        error: null,
      };
    }
    case "connect-started": {
      if (state.view !== "disconnected") return state;
      return { ...state, busy: true, error: null, insecureWarning: false };
    }
    case "pairing-started": {
      return {
        view: "pairing",
        baseUrl: event.baseUrl,
        code: event.code,
        expiresAt: event.expiresAt,
        error: null,
      };
    }
    case "pairing-failed": {
      if (state.view === "disconnected") {
        return { ...state, busy: false, error: event.error };
      }
      return disconnected({ error: event.error });
    }
    case "pairing-cancelled":
    case "disconnected": {
      return disconnected();
    }
    case "arm-started": {
      if (state.view === "connected")
        return { ...state, arming: true, error: null };
      if (state.view === "needs-site-access") {
        return {
          view: "connected",
          baseUrl: state.baseUrl,
          justPaired: false,
          arming: true,
          error: null,
        };
      }
      return state;
    }
    case "arm-succeeded": {
      const baseUrl =
        state.view === "connected" || state.view === "needs-site-access"
          ? state.baseUrl
          : "";
      return { view: "armed", baseUrl };
    }
    case "arm-failed": {
      const baseUrl =
        state.view === "connected" || state.view === "needs-site-access"
          ? state.baseUrl
          : "";
      if (event.code === "no-site-access") {
        return { view: "needs-site-access", baseUrl, message: event.error };
      }
      return {
        view: "connected",
        baseUrl,
        justPaired: false,
        arming: false,
        error: event.error,
      };
    }
    case "site-access-retry": {
      if (state.view !== "needs-site-access") return state;
      return {
        view: "connected",
        baseUrl: state.baseUrl,
        justPaired: false,
        arming: false,
        error: null,
      };
    }
  }
}
