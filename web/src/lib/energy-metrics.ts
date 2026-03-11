/**
 * Lightweight energy-usage metrics tracker for diagnosing Safari PWA kills.
 *
 * Safari terminates PWAs that consume "significant energy" in the background.
 * This module tracks network activity, timer fires, and visibility transitions
 * so we can diagnose what was happening before a kill.
 *
 * Data is persisted to localStorage on a rolling basis and beaconed to the
 * backend on visibilitychange→hidden, so it survives forced reloads.
 */

const STORAGE_KEY = "dispatch:energyMetrics";
const BEACON_PATH = "/api/v1/energy-report";
const FLUSH_INTERVAL_MS = 30_000;
const MAX_VISIBILITY_CHANGES = 20;
const MAX_ERRORS = 10;

export interface EnergyMetrics {
  windowStart: number;
  windowEnd: number;
  visibilityState: string;

  sseEventsReceived: number;
  sseReconnects: number;
  wsReconnects: number;
  httpRequests: number;

  healthPollFires: number;
  healthPollSkips: number;
  releaseManagerPollFires: number;

  visibilityChanges: { at: number; to: string }[];

  totalHiddenMs: number;
  longestHiddenMs: number;

  errors: { at: number; msg: string }[];
}

function createEmpty(): EnergyMetrics {
  return {
    windowStart: Date.now(),
    windowEnd: Date.now(),
    visibilityState: document.visibilityState,
    sseEventsReceived: 0,
    sseReconnects: 0,
    wsReconnects: 0,
    httpRequests: 0,
    healthPollFires: 0,
    healthPollSkips: 0,
    releaseManagerPollFires: 0,
    visibilityChanges: [],
    totalHiddenMs: 0,
    longestHiddenMs: 0,
    errors: [],
  };
}

let metrics: EnergyMetrics = createEmpty();
let hiddenSince: number | null = document.hidden ? Date.now() : null;
let flushTimer: number | null = null;

function save(): void {
  metrics.windowEnd = Date.now();
  metrics.visibilityState = document.visibilityState;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(metrics));
  } catch {
    // Storage full or unavailable — ignore
  }
}

function beacon(): void {
  // Flush hidden-time before sending
  if (hiddenSince !== null) {
    const elapsed = Date.now() - hiddenSince;
    metrics.totalHiddenMs += elapsed;
    if (elapsed > metrics.longestHiddenMs) {
      metrics.longestHiddenMs = elapsed;
    }
    hiddenSince = Date.now(); // reset for continued tracking
  }
  save();
  try {
    const body = JSON.stringify(metrics);
    navigator.sendBeacon(BEACON_PATH, body);
  } catch {
    // sendBeacon not available or failed — data is still in localStorage
  }
}

// --- Public API ---

export function recordSSEEvent(): void {
  metrics.sseEventsReceived++;
}

export function recordSSEReconnect(): void {
  metrics.sseReconnects++;
}

export function recordWSReconnect(): void {
  metrics.wsReconnects++;
}

export function recordHTTPRequest(): void {
  metrics.httpRequests++;
}

export function recordHealthPollFire(): void {
  metrics.healthPollFires++;
}

export function recordHealthPollSkip(): void {
  metrics.healthPollSkips++;
}

export function recordReleaseManagerPollFire(): void {
  metrics.releaseManagerPollFires++;
}

export function recordError(msg: string): void {
  metrics.errors.push({ at: Date.now(), msg });
  if (metrics.errors.length > MAX_ERRORS) {
    metrics.errors = metrics.errors.slice(-MAX_ERRORS);
  }
}

/**
 * Read the previous session's metrics from localStorage (e.g. after a
 * Safari-forced reload). Returns null if no data is stored.
 */
export function readPreviousMetrics(): EnergyMetrics | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as EnergyMetrics;
  } catch {
    return null;
  }
}

/**
 * Initialize the metrics tracker. Call once on app mount.
 * Returns a cleanup function.
 */
export function initEnergyMetrics(): () => void {
  // Log previous session metrics if they exist (helps debugging after a kill)
  const prev = readPreviousMetrics();
  if (prev) {
    const age = Date.now() - prev.windowEnd;
    // Only log if the previous session ended recently (< 5 min ago),
    // which suggests a Safari kill rather than a normal close
    if (age < 5 * 60 * 1000) {
      console.warn(
        "[dispatch:energy] Previous session metrics (possible Safari kill):",
        prev
      );
    }
  }

  // Reset for this session
  metrics = createEmpty();

  // Toggle data-hidden attribute on <html> for CSS animation pausing
  const syncHiddenAttr = () => {
    if (document.hidden) {
      document.documentElement.setAttribute("data-hidden", "");
    } else {
      document.documentElement.removeAttribute("data-hidden");
    }
  };
  syncHiddenAttr();

  const onVisibilityChange = () => {
    const now = Date.now();
    syncHiddenAttr();
    if (document.hidden) {
      hiddenSince = now;
      beacon();
    } else {
      if (hiddenSince !== null) {
        const elapsed = now - hiddenSince;
        metrics.totalHiddenMs += elapsed;
        if (elapsed > metrics.longestHiddenMs) {
          metrics.longestHiddenMs = elapsed;
        }
        hiddenSince = null;
      }
    }

    metrics.visibilityChanges.push({ at: now, to: document.visibilityState });
    if (metrics.visibilityChanges.length > MAX_VISIBILITY_CHANGES) {
      metrics.visibilityChanges = metrics.visibilityChanges.slice(
        -MAX_VISIBILITY_CHANGES
      );
    }
  };

  document.addEventListener("visibilitychange", onVisibilityChange);

  // Periodic flush to localStorage
  flushTimer = window.setInterval(save, FLUSH_INTERVAL_MS);

  return () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (flushTimer !== null) {
      window.clearInterval(flushTimer);
      flushTimer = null;
    }
  };
}
