/** The drawer's width until someone drags it, and what a reset goes back to. */
export const DRAWER_WIDTH_PX = 400;
export const DRAWER_TRANSITION_MS = 300;
export const DRAWER_SETTLE_FALLBACK_MS = DRAWER_TRANSITION_MS + 40;

// Narrowest the drawer goes: the left sidebar's width (320). A thread's
// review findings, composer and attachment rows are laid out for a phone's
// width, and 320 is the narrowest phone we render them at, so nothing in
// the drawer has to learn a narrower layout.
export const DRAWER_MIN_WIDTH_PX = 320;

// The left navigation sidebar's width while it is open.
export const NAV_SIDEBAR_WIDTH_PX = 320;

// A floating drawer slides over everything, so the only thing it must
// leave is a strip for its own left edge: the resize handle sits on that
// edge, and 48 keeps it on screen with a touch target's worth of page
// beside it to aim at, and a sliver of what is underneath so the drawer
// never reads as the whole window.
export const DRAWER_EDGE_GUTTER_PX = 48;

// A pinned drawer takes its width out of the centre column, which stays
// usable down to about a phone's width: the stream and its composer wrap
// but keep every control. Much under 320 the composer's placeholder and a
// post's text wrap a word a line, and at 0 the drawer pushes its own close
// button off the window. So a pinned drawer leaves the centre this, plus
// the left sidebar when it is open.
export const DRAWER_PINNED_CENTRE_MIN_PX = 320;

/** What a pinned drawer leaves the rest of the row, by left sidebar state. */
export function drawerPinnedReserve(navSidebarOpen: boolean): number {
  return (
    DRAWER_PINNED_CENTRE_MIN_PX + (navSidebarOpen ? NAV_SIDEBAR_WIDTH_PX : 0)
  );
}

/** How far one arrow press moves the resize handle; Shift moves it further. */
export const DRAWER_KEYBOARD_STEP_PX = 16;
export const DRAWER_KEYBOARD_BIG_STEP_PX = 64;

/**
 * The widest the drawer may be in a viewport this wide, leaving `reserve`
 * (the edge gutter floating, `drawerPinnedReserve` pinned). Never below
 * the default, so a narrow window keeps the drawer it always had rather
 * than one squeezed under its old size.
 */
export function drawerMaxWidth(viewportWidth: number, reserve: number): number {
  return Math.max(DRAWER_WIDTH_PX, viewportWidth - reserve);
}

export function clampDrawerWidth(
  width: number,
  viewportWidth: number,
  reserve: number
): number {
  if (!Number.isFinite(width)) return DRAWER_WIDTH_PX;
  return Math.round(
    Math.min(
      Math.max(width, DRAWER_MIN_WIDTH_PX),
      drawerMaxWidth(viewportWidth, reserve)
    )
  );
}
