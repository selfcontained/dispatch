/**
 * Safari exposes the promise-based WebExtension API on `browser`; Chrome on
 * `chrome`. Every call this codebase makes is promise-style and structurally
 * identical across both, so a namespace alias is the entire compatibility
 * layer — no polyfill dependency needed.
 */
const globals = globalThis as typeof globalThis & {
  browser?: typeof chrome;
  chrome?: typeof chrome;
};

export const api: typeof chrome =
  globals.browser ?? (globals.chrome as typeof chrome);
