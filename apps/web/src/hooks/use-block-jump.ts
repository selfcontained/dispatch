/**
 * Jumping to one block of the stream: a sidebar row's running turn, or a
 * pasted `?block=<id>` link. The URL names the block (so a reload or a
 * shared link lands in the same place); the navigation's history state
 * carries a fresh nonce per click, so clicking the same row again jumps
 * again even though the URL did not change.
 */
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { agentTurnLocation, BLOCK_PARAM } from "@/lib/agent-routes";

type BlockJumpState = {
  blockJump?: string;
  blockJumpBehavior?: ScrollBehavior;
} | null;

let jumpSeq = 0;

/** Open an agent's page on its running turn. */
export function useJumpToTurn(): (
  agentId: string,
  turn: { blockId: string; threadId: string | null },
  behavior?: ScrollBehavior
) => void {
  const navigate = useNavigate();
  return useCallback(
    (agentId, turn, behavior = "auto") => {
      // Unique across reloads too: history state outlives a reload, and a
      // counter alone would restart and repeat a nonce already handled.
      jumpSeq += 1;
      const state: BlockJumpState = {
        blockJump: `${Date.now()}-${jumpSeq}`,
        blockJumpBehavior: behavior,
      };
      navigate(agentTurnLocation(agentId, turn), { state });
    },
    [navigate]
  );
}

export type BlockJump = { blockId: string; at: number };

/** Room left above a block too tall to centre. */
const JUMP_GAP_PX = 8;
/** How long the mark stays on the block (matches `chat-jump-flash`). */
export const JUMP_FLASH_MS = 2400;

/** The row rendered for `entryId` under `root`, if it is there. */
export function findEntryNode(
  root: HTMLElement,
  entryId: string
): HTMLElement | null {
  for (const node of root.querySelectorAll<HTMLElement>(
    "[data-chat-entry-id]"
  )) {
    if (node.dataset.chatEntryId === entryId) return node;
  }
  return null;
}

/**
 * Scroll `scroller` so `node` sits in the middle of the view, or at the top
 * when it is taller than the view.
 */
export function scrollBlockIntoView(
  scroller: HTMLElement,
  node: HTMLElement,
  behavior: ScrollBehavior = "auto"
): void {
  const nodeRect = node.getBoundingClientRect();
  const top =
    nodeRect.top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  const room = scroller.clientHeight - nodeRect.height;
  const target = Math.max(0, top - Math.max(JUMP_GAP_PX, room / 2));
  if (
    behavior === "smooth" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    scroller.scrollTo({ top: target, behavior: "smooth" });
  } else {
    scroller.scrollTop = target;
  }
}

/** Hold list anchoring until native smooth scrolling finishes or the reader interrupts. */
function smoothBlockJump(
  scroller: HTMLElement,
  node: HTMLElement,
  done: () => void
): () => void {
  let finished = false;
  let idle: number;
  const finish = (arrived: boolean) => {
    if (finished) return;
    finished = true;
    window.clearTimeout(idle);
    window.clearTimeout(deadline);
    scroller.removeEventListener("scroll", progress);
    scroller.removeEventListener("wheel", cancel);
    scroller.removeEventListener("touchstart", cancel);
    scroller.removeEventListener("keydown", cancel);
    if (arrived && node.isConnected) scrollBlockIntoView(scroller, node);
    else scroller.scrollTo({ top: scroller.scrollTop, behavior: "instant" });
    done();
  };
  const cancel = () => finish(false);
  const end = () => finish(true);
  const progress = () => {
    window.clearTimeout(idle);
    idle = window.setTimeout(end, 150);
  };
  scroller.addEventListener("scroll", progress, { passive: true });
  scroller.addEventListener("wheel", cancel, { passive: true });
  scroller.addEventListener("touchstart", cancel, { passive: true });
  scroller.addEventListener("keydown", cancel);
  // Use a quiet scroll interval rather than scrollend: an event queued by
  // the preceding scroll can arrive after this animation has started.
  // The deadline also handles an already-aligned target.
  progress();
  const deadline = window.setTimeout(end, 2000);
  scrollBlockIntoView(scroller, node, "smooth");
  return cancel;
}

/**
 * Scrolls `scrollRef` to the row for the URL's `block` once it is on
 * screen, and marks it briefly. A row matches by `data-chat-entry-id`, the
 * wrapper every feed row (a pending turn's status line included) and
 * every thread reply renders in. The target may not be there yet — the
 * feed still loading, the turn's block not published — so this looks
 * again on every render until it appears.
 *
 * `onJump` runs just before the scroll, for a pane that must stop pinning
 * its bottom; `onJumped` once scrolling settles (or is interrupted), for a windowed list that must hold
 * the new place from there. Returns a ref to the last jump, for a pane whose own scroll
 * bookkeeping must not undo it straight away.
 */
export function useBlockJump(
  scrollRef: RefObject<HTMLElement>,
  onJump?: (blockId: string) => void | (() => void),
  onJumped?: (blockId: string) => void
): RefObject<BlockJump | null> {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const blockId = searchParams.get(BLOCK_PARAM);
  const nonce = (location.state as BlockJumpState)?.blockJump ?? null;
  const handledRef = useRef({
    blocks: new Set<string>(),
    nonces: new Set<string>(),
  });
  const jumpedRef = useRef<BlockJump | null>(null);
  const animationRef = useRef<{
    blockId: string;
    nonce: string | null;
    cancel: () => void;
  } | null>(null);
  const flashRef = useRef<{ node: HTMLElement; timer: number } | null>(null);
  const onJumpRef = useRef(onJump);
  onJumpRef.current = onJump;
  const onJumpedRef = useRef(onJumped);
  onJumpedRef.current = onJumped;

  // Every render: the target can arrive with any update to the content.
  useLayoutEffect(() => {
    if (
      animationRef.current &&
      (animationRef.current.blockId !== blockId ||
        animationRef.current.nonce !== nonce)
    ) {
      animationRef.current.cancel();
      animationRef.current = null;
    }
    if (!blockId) return;
    const handled = handledRef.current;
    // A click's nonce is its own request. With none (a pasted link, a
    // reload, or a later search-param change that dropped the state), the
    // block is jumped to once per mount.
    const pending = nonce
      ? !handled.nonces.has(nonce)
      : !handled.blocks.has(blockId);
    if (!pending) return;
    const scroller = scrollRef.current;
    const node = scroller ? findEntryNode(scroller, blockId) : null;
    if (!scroller || !node) return;
    handled.blocks.add(blockId);
    if (nonce) handled.nonces.add(nonce);
    jumpedRef.current = { blockId, at: Date.now() };
    const release = onJumpRef.current?.(blockId);
    const finish = () => {
      release?.();
      onJumpedRef.current?.(blockId);
      animationRef.current = null;
    };
    const smooth =
      (location.state as BlockJumpState)?.blockJumpBehavior === "smooth" &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (smooth) {
      animationRef.current = {
        blockId,
        nonce,
        cancel: smoothBlockJump(scroller, node, finish),
      };
    } else {
      scrollBlockIntoView(scroller, node);
      finish();
    }
    const prev = flashRef.current;
    if (prev) {
      window.clearTimeout(prev.timer);
      prev.node.removeAttribute("data-jump-flash");
    }
    // Restart the animation even on the same node.
    void node.offsetWidth;
    node.setAttribute("data-jump-flash", "");
    flashRef.current = {
      node,
      timer: window.setTimeout(() => {
        node.removeAttribute("data-jump-flash");
        flashRef.current = null;
      }, JUMP_FLASH_MS),
    };
  });

  useEffect(
    () => () => {
      animationRef.current?.cancel();
      if (flashRef.current) window.clearTimeout(flashRef.current.timer);
    },
    []
  );

  return jumpedRef;
}
