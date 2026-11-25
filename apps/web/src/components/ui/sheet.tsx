/**
 * Sheet: the one slide-over. It comes in from the right (from the left for
 * navigation, from the bottom on a phone for a short pick) and has one way
 * out, three times over: the close button, Escape while it is the top layer,
 * and a press outside.
 *
 * - `modal`: a scrim over the page, and focus held inside.
 * - not modal: floats beside a page that stays usable. A press outside
 *   closes it and still lands on what was pressed.
 * - `docked`: a pinned column. It is part of the layout, so it only closes
 *   from its button unless it says it is `dismissable`.
 */
import * as React from "react";
import { createPortal } from "react-dom";
import { DismissableLayer } from "@radix-ui/react-dismissable-layer";
import { X } from "lucide-react";

import { glassPanel } from "@/lib/glass";
import { cn } from "@/lib/utils";
import { IconButton } from "./icon-button";
import { opensFrom, slidAway } from "./return-focus";

const SLIDE_MS = 300;
/** For a transition that never ends: a hidden or reduced-motion panel. */
export const SHEET_SETTLE_FALLBACK_MS = SLIDE_MS + 40;

/** Layers of their own: a press on one is not a press outside the sheet. */
const ABOVE =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], [data-sonner-toaster], [data-sheet-scrim]';
const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

const AncestorPanelsContext = React.createContext<
  React.RefObject<HTMLDivElement>[]
>([]);

const ClosingContext = React.createContext(false);

/**
 * True while the sheet around this content slides shut, so content whose data
 * goes the moment it closes can hold its last render until the slide ends.
 */
export function useSheetClosing(): boolean {
  return React.useContext(ClosingContext);
}

/** `settle` ends a close in progress; opening again ends it too. */
function useClosing(open: boolean) {
  const [closing, setClosing] = React.useState(false);
  const [prevOpen, setPrevOpen] = React.useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    setClosing(!open);
  }
  // Only a close in progress: a queued setClosing(false) would land after
  // the next close's setClosing(true) and cut it off before it slides.
  const settle = () => {
    if (closing) setClosing(false);
  };
  React.useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(
      () => setClosing(false),
      SHEET_SETTLE_FALLBACK_MS
    );
    return () => window.clearTimeout(timer);
  }, [closing]);
  return { closing, settle };
}

/** Focus goes in as it opens, and back to what opened it as it closes. */
function useSheetFocus({
  open,
  panel,
  focusedInside,
  takeFocus,
  trapped,
  returnFocus,
}: {
  open: boolean;
  focusedInside: React.MutableRefObject<boolean>;
  panel: React.RefObject<HTMLDivElement>;
  takeFocus: boolean;
  trapped: boolean;
  returnFocus?: () => void;
}) {
  const opener = React.useRef<{ element: HTMLElement; testId?: string } | null>(
    null
  );
  const wasOpen = React.useRef(false);
  const restore = React.useRef(returnFocus);
  restore.current = returnFocus;
  // Read while rendering, before anything inside can take focus.
  if (open && !wasOpen.current) {
    const element = opensFrom(document.activeElement);
    opener.current = element
      ? { element, testId: element.dataset.testid }
      : null;
  }
  React.useLayoutEffect(() => {
    if (open === wasOpen.current) return;
    wasOpen.current = open;
    const active = document.activeElement;
    if (open) {
      if (takeFocus && !panel.current?.contains(active))
        panel.current?.focus({ preventScroll: true });
      return;
    }
    // Focus that has already moved on is where the user put it.
    if (active && active !== document.body && !panel.current?.contains(active))
      return;
    if (restore.current) return restore.current();
    const from = opener.current;
    if (!from) return;
    // A toggle that hides while its sheet is open comes back as a new node.
    const target = from.element.isConnected
      ? from.element
      : from.testId
        ? document.querySelector<HTMLElement>(`[data-testid="${from.testId}"]`)
        : null;
    if (target && !slidAway(target)) target.focus({ preventScroll: true });
  }, [open, panel, takeFocus]);

  React.useEffect(() => {
    if (!open || !trapped) return;
    // A menu that opened the sheet hands focus back to its trigger as it
    // closes. Focus belongs in the sheet, or in a layer above it.
    const onFocusIn = ({ target }: FocusEvent) => {
      // Set through React's tree, so it covers what the content portals out.
      const inside = focusedInside.current;
      focusedInside.current = false;
      if (
        !inside &&
        target instanceof Element &&
        target !== document.body &&
        !panel.current?.contains(target) &&
        !target.closest(ABOVE)
      )
        panel.current?.focus({ preventScroll: true });
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [open, panel, trapped, focusedInside]);
}

function wrapTab(event: React.KeyboardEvent, panel: HTMLElement) {
  const active = document.activeElement;
  if (!panel.contains(active)) return;
  const stops = [...panel.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (element) => element.getClientRects().length > 0
  );
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!first || !last) return event.preventDefault();
  if (event.shiftKey && (active === first || active === panel)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Escape and a press outside, as a layer in Radix's stack so a menu or
 * dialog opened over the sheet takes them first. It renders no content: the
 * sheet stays mounted while closed, and this only while open.
 */
function SheetDismiss({
  panel,
  pressedInside,
  onEscape,
  onOutsidePress,
  keepOpen,
}: {
  panel: React.RefObject<HTMLDivElement>;
  /** Set through React's tree, so it covers what the content portals out. */
  pressedInside: React.MutableRefObject<boolean>;
  onEscape: () => void;
  onOutsidePress?: () => void;
  keepOpen?: string;
}) {
  const ancestors = React.useContext(AncestorPanelsContext);
  const escape = React.useRef(onEscape);
  escape.current = onEscape;
  const popoverWasOpen = React.useRef(false);
  const cancelEscape = React.useRef<() => void>();
  React.useEffect(() => () => cancelEscape.current?.(), []);
  React.useEffect(() => {
    const onPointerDown = () => {
      pressedInside.current = false;
      popoverWasOpen.current = Boolean(
        document.querySelector(
          '[data-radix-popper-content-wrapper] > [data-state="open"]'
        )
      );
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [pressedInside]);

  return (
    <DismissableLayer
      className="hidden"
      onEscapeKeyDown={(event) => {
        if (event.isComposing) return;
        // A viewer over the sheet that isn't a Radix layer.
        const modals = document.querySelectorAll('[aria-modal="true"]');
        if (
          [...modals].some(
            (modal) =>
              !panel.current?.contains(modal) &&
              !ancestors.some((ancestor) => ancestor.current === modal)
          )
        )
          return;
        const target = event.target instanceof Element ? event.target : null;
        // The editor prevents every Escape, suggestions or not. With none
        // open, the key is the sheet's.
        if (
          target?.closest('[data-chat-composer][aria-expanded="false"]') &&
          !target.closest("[data-escape-owner]")
        ) {
          event.preventDefault();
          escape.current();
          return;
        }
        // Radix hears the key first, on the way down. Wait for the way back
        // up: whatever handled it on the way keeps it.
        const onBubble = (key: KeyboardEvent) => {
          cancelEscape.current?.();
          if (key.key !== "Escape" || key.defaultPrevented) return;
          key.preventDefault();
          escape.current();
        };
        cancelEscape.current?.();
        window.addEventListener("keydown", onBubble);
        const timer = window.setTimeout(() => cancelEscape.current?.(), 0);
        cancelEscape.current = () => {
          window.clearTimeout(timer);
          window.removeEventListener("keydown", onBubble);
        };
      }}
      onPointerDownOutside={({ target, detail }) => {
        if (!onOutsidePress || pressedInside.current) return;
        if (detail.originalEvent.button > 0) return;
        // A touch is delivered on click, by which time the pressed control
        // may have replaced itself. That is no evidence of a press outside.
        if (!(target instanceof Node) || !target.isConnected) return;
        if (panel.current?.contains(target)) return;
        if (target instanceof Element) {
          if (target.closest(ABOVE)) return;
          if (keepOpen && target.closest(keepOpen)) return;
        }
        // The first press outside an open popover closes just the popover.
        if (popoverWasOpen.current) return;
        onOutsidePress();
      }}
    />
  );
}

type Side = "left" | "right" | "bottom";

const MODAL_SIDE: Record<
  Side,
  { panel: string; closed: string; enter: string; edge: string }
> = {
  right: {
    panel: "bottom-0 right-0 top-[var(--exposure-banner-height,0px)] w-screen",
    closed: "translate-x-full",
    enter: "animate-sheet-in-right",
    edge: "md:rounded-l-xl md:border-l",
  },
  left: {
    panel: "bottom-0 left-0 top-[var(--exposure-banner-height,0px)] w-screen",
    closed: "-translate-x-full",
    enter: "animate-sheet-in-left",
    edge: "md:rounded-r-xl md:border-r",
  },
  bottom: {
    panel:
      "inset-x-0 bottom-0 flex max-h-[85dvh] flex-col md:left-auto md:top-[var(--exposure-banner-height,0px)] md:max-h-none md:w-96",
    closed: "translate-y-full md:translate-x-full md:translate-y-0",
    enter: "animate-sheet-in-bottom md:animate-sheet-in-right",
    edge: "rounded-t-xl border-t md:rounded-t-none md:rounded-l-xl md:border-l md:border-t-0",
  },
};

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  /** Names it to a screen reader. */
  label?: string;
  side?: Side;
  modal?: boolean;
  /** A dialog beside a live page. A modal sheet always is one. */
  dialog?: boolean;
  docked?: boolean;
  /** Escape and a press outside close it. On unless docked. */
  dismissable?: boolean;
  /** `md` stops at 28rem from tablet up; `full` covers the screen. */
  size?: "full" | "md";
  /**
   * Whether closed content stays mounted, for a terminal or a draft. One
   * that doesn't is portalled, so it can open from inside any header.
   */
  keepMounted?: boolean;
  /** Escape steps back a page first in a sheet that stacks them. */
  onEscape?: () => void;
  /** Instead of closing, when a press outside has to close it differently. */
  onOutsidePress?: () => void;
  /** Matches what opens this sheet or switches what it shows. */
  keepOpen?: string;
  /** Moves focus in on open. A modal sheet always does. */
  autoFocus?: boolean;
  /** Where focus goes on close, when its opener will be gone. */
  returnFocus?: () => void;
  /** Width of a sheet that isn't modal, and how far it overlaps when docked. */
  width?: number;
  overlap?: number;
  resizing?: boolean;
  /** Drawn on its edge, outside the content: the resize handle. */
  edge?: React.ReactNode;
  className?: string;
  "data-testid"?: string;
}

export function Sheet({
  open,
  onOpenChange,
  children,
  label,
  side = "right",
  modal = true,
  dialog = modal,
  docked = false,
  dismissable = !docked,
  size = "full",
  keepMounted = true,
  onEscape,
  onOutsidePress,
  keepOpen,
  autoFocus = modal,
  returnFocus,
  width,
  overlap = 0,
  resizing = false,
  edge,
  className,
  "data-testid": testId,
}: SheetProps): JSX.Element | null {
  const ancestors = React.useContext(AncestorPanelsContext);
  const panel = React.useRef<HTMLDivElement>(null);
  const pressedInside = React.useRef(false);
  const focusedInside = React.useRef(false);
  const { closing, settle } = useClosing(open);
  useSheetFocus({
    open,
    panel,
    focusedInside,
    takeFocus: autoFocus,
    trapped: modal,
    returnFocus,
  });

  // A resize changes the width that an open or close animates, so only a
  // transition an open or close started may settle one.
  const toggleInFlight = React.useRef(false);
  const mounted = React.useRef(false);
  React.useLayoutEffect(() => {
    if (mounted.current) toggleInFlight.current = true;
    mounted.current = true;
  }, [open]);
  React.useLayoutEffect(() => {
    // A drag runs with no transition, so cuts short one in flight.
    if (resizing) toggleInFlight.current = false;
  }, [resizing]);

  if (!keepMounted && !open && !closing) return null;

  const close = () => onOpenChange(false);
  const slides = !modal && docked ? "width" : "transform";
  const shape = MODAL_SIDE[side];
  const transitionDuration = `${resizing ? 0 : SLIDE_MS}ms`;
  const style: React.CSSProperties = modal
    ? { transitionDuration }
    : docked
      ? {
          width: open ? width : 0,
          marginLeft: open ? -overlap : 0,
          transitionDuration,
        }
      : {
          width,
          transform: open ? "translateX(0)" : `translateX(${width}px)`,
          transitionDuration,
        };

  const sheet = (
    <>
      {modal ? (
        <div
          aria-hidden="true"
          data-sheet-scrim=""
          className={cn(
            "fixed inset-x-0 bottom-0 top-[var(--exposure-banner-height,0px)] z-drawer bg-scrim backdrop-blur-md transition-opacity duration-300 motion-reduce:transition-none",
            open
              ? !keepMounted &&
                  "animate-sheet-fade-in motion-reduce:animate-none"
              : "pointer-events-none opacity-0"
          )}
          onClick={close}
        />
      ) : null}
      <div
        ref={panel}
        data-testid={testId}
        data-sheet=""
        data-pinned={modal ? undefined : String(docked)}
        data-closing={closing ? "true" : undefined}
        data-resizing={resizing ? "true" : undefined}
        role={open && dialog ? "dialog" : undefined}
        aria-modal={open && modal ? true : undefined}
        aria-label={open && dialog ? label : undefined}
        tabIndex={open && autoFocus ? -1 : undefined}
        className={cn(
          "outline-none motion-reduce:transition-none",
          modal
            ? [
                "fixed z-drawer-panel transition-transform",
                shape.panel,
                size === "md" && "md:w-[28rem]",
                open
                  ? !keepMounted && [shape.enter, "motion-reduce:animate-none"]
                  : ["pointer-events-none", shape.closed],
              ]
            : docked
              ? "relative h-full min-w-0 flex-none overflow-hidden transition-[width,margin-left] ease-out"
              : [
                  // Fixed, so the closed panel parked off-canvas is no
                  // overflow on the row: anything that scrollIntoViews there
                  // would drag the whole app sideways.
                  "fixed bottom-0 right-0 top-[var(--exposure-banner-height,0px)] z-dock transition-transform ease-out",
                  !open && "pointer-events-none",
                ]
        )}
        style={style}
        onPointerDownCapture={() => {
          pressedInside.current = true;
        }}
        onFocusCapture={() => {
          focusedInside.current = true;
        }}
        onKeyDown={(event) => {
          if (modal && event.key === "Tab" && panel.current)
            wrapTab(event, panel.current);
        }}
        onTransitionEnd={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.propertyName !== slides) return;
          if (!toggleInFlight.current) return;
          toggleInFlight.current = false;
          settle();
        }}
      >
        {edge}
        <div
          className={cn(
            "flex min-h-0 w-full flex-col text-foreground",
            modal && side === "bottom" ? "flex-1" : "h-full",
            glassPanel,
            modal
              ? (side === "bottom" || size === "md") && shape.edge
              : "rounded-l-lg border-l",
            className
          )}
          style={!modal && docked ? { width } : undefined}
          {...(open ? {} : { inert: "" })}
        >
          <ClosingContext.Provider value={closing}>
            <AncestorPanelsContext.Provider value={[...ancestors, panel]}>
              {children}
            </AncestorPanelsContext.Provider>
          </ClosingContext.Provider>
        </div>
      </div>
      {open && dismissable ? (
        <SheetDismiss
          panel={panel}
          pressedInside={pressedInside}
          keepOpen={keepOpen}
          onEscape={onEscape ?? close}
          // The scrim takes a modal sheet's press outside, as a click, so
          // the press never lands on what is under it.
          onOutsidePress={modal ? undefined : (onOutsidePress ?? close)}
        />
      ) : null}
    </>
  );
  return keepMounted ? sheet : createPortal(sheet, document.body);
}

/** Always the last control in the sheet's header, top right. */
export function SheetClose({
  onClick,
  "data-testid": testId,
}: {
  onClick: () => void;
  "data-testid"?: string;
}): JSX.Element {
  return (
    <IconButton
      size="icon-sm"
      label="Close"
      className="shrink-0"
      data-testid={testId}
      onClick={onClick}
    >
      <X aria-hidden="true" />
    </IconButton>
  );
}

/** A sheet's plain header. One with tabs or an identity draws its own. */
export function SheetHeader({
  title,
  description,
  onClose,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="shrink-0 border-b border-border-subtle pt-safe">
      <div className="flex min-h-14 items-center gap-2 pl-4 pr-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-heading-md">{title}</h2>
          {description ? (
            <p className="truncate text-body-sm text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        <SheetClose onClick={onClose} />
      </div>
    </div>
  );
}
