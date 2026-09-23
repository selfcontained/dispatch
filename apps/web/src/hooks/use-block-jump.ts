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

type BlockJumpState = { blockJump?: string } | null;

let jumpSeq = 0;

/** Open an agent's page on its running turn. */
export function useJumpToTurn(): (
  agentId: string,
  turn: { blockId: string; threadId: string | null }
) => void {
  const navigate = useNavigate();
  return useCallback(
    (agentId, turn) => {
      // Unique across reloads too: history state outlives a reload, and a
      // counter alone would restart and repeat a nonce already handled.
      jumpSeq += 1;
      const state: BlockJumpState = { blockJump: `${Date.now()}-${jumpSeq}` };
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
  node: HTMLElement
): void {
  const nodeRect = node.getBoundingClientRect();
  const top =
    nodeRect.top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  const room = scroller.clientHeight - nodeRect.height;
  scroller.scrollTop = Math.max(0, top - Math.max(JUMP_GAP_PX, room / 2));
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
 * its bottom; `onJumped` just after, for a windowed list that must hold
 * the new place from there. Returns a ref to the last jump, for a pane whose own scroll
 * bookkeeping must not undo it straight away.
 */
export function useBlockJump(
  scrollRef: RefObject<HTMLElement>,
  onJump?: (blockId: string) => void,
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
  const flashRef = useRef<{ node: HTMLElement; timer: number } | null>(null);
  const onJumpRef = useRef(onJump);
  onJumpRef.current = onJump;
  const onJumpedRef = useRef(onJumped);
  onJumpedRef.current = onJumped;

  // Every render: the target can arrive with any update to the content.
  useLayoutEffect(() => {
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
    onJumpRef.current?.(blockId);
    scrollBlockIntoView(scroller, node);
    onJumpedRef.current?.(blockId);
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
      if (flashRef.current) window.clearTimeout(flashRef.current.timer);
    },
    []
  );

  return jumpedRef;
}
