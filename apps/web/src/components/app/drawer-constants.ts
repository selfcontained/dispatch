/** The drawer's width until someone drags it, and what a reset goes back to. */
export const DRAWER_WIDTH_PX = 400;
export const DRAWER_TRANSITION_MS = 300;
export const DRAWER_SETTLE_FALLBACK_MS = DRAWER_TRANSITION_MS + 40;

// Narrowest the drawer goes: the left sidebar's width (320). A thread's
// review findings, composer and attachment rows are laid out for a phone's
// width, and 320 is the narrowest phone we render them at, so nothing in
// the drawer has to learn a narrower layout.
export const DRAWER_MIN_WIDTH_PX = 320;

// What the drawer leaves the rest of the row at its widest: the left
// sidebar (320) plus a centre column of 400, about where the agent pane's
// header and composer stop fitting on one line. A pinned drawer takes its
// width out of the centre, so this is the room the centre keeps.
export const DRAWER_CENTRE_RESERVE_PX = 720;

/** How far one arrow press moves the resize handle; Shift moves it further. */
export const DRAWER_KEYBOARD_STEP_PX = 16;
export const DRAWER_KEYBOARD_BIG_STEP_PX = 64;

/**
 * The widest the drawer may be in a viewport this wide. Never below the
 * default, so a narrow window keeps the drawer it always had rather than
 * one squeezed under its old size.
 */
export function drawerMaxWidth(viewportWidth: number): number {
  return Math.max(DRAWER_WIDTH_PX, viewportWidth - DRAWER_CENTRE_RESERVE_PX);
}

export function clampDrawerWidth(width: number, viewportWidth: number): number {
  if (!Number.isFinite(width)) return DRAWER_WIDTH_PX;
  return Math.round(
    Math.min(
      Math.max(width, DRAWER_MIN_WIDTH_PX),
      drawerMaxWidth(viewportWidth)
    )
  );
}
