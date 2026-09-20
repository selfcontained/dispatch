/**
 * What the right drawer is showing, read from the URL: `?thread=<id>` puts
 * a block's thread (or a review) on top of the drawer's home page, and
 * `&finding=<id>` puts one of the review's findings on top of that. Pages
 * stack, so going back pops one; closing the drawer pops them all. The URL
 * is the state: a reload or a shared link lands on the same page.
 */
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import { FINDING_PARAM, THREAD_PARAM } from "@/lib/agent-routes";

export type DrawerRoute = {
  threadId: string | null;
  findingId: string | null;
  /** How many pages sit over the drawer's home: 0, 1 (thread) or 2 (finding). */
  depth: number;
  /** Push a thread, or a finding on a review, over the home page. */
  openThread: (blockId: string, findingId?: string) => void;
  /** Pop the top page. */
  back: () => void;
  /** Pop every page: the drawer shows its home again. */
  closeAll: () => void;
};

export function useDrawerRoute(): DrawerRoute {
  const [searchParams, setSearchParams] = useSearchParams();
  const threadId = searchParams.get(THREAD_PARAM);
  const findingId = threadId ? searchParams.get(FINDING_PARAM) : null;

  const openThread = useCallback(
    (blockId: string, finding?: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set(THREAD_PARAM, blockId);
        if (finding) next.set(FINDING_PARAM, finding);
        else next.delete(FINDING_PARAM);
        return next;
      });
    },
    [setSearchParams]
  );

  const back = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (next.has(FINDING_PARAM)) next.delete(FINDING_PARAM);
      else next.delete(THREAD_PARAM);
      return next;
    });
  }, [setSearchParams]);

  const closeAll = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (!next.has(THREAD_PARAM) && !next.has(FINDING_PARAM)) return prev;
        next.delete(THREAD_PARAM);
        next.delete(FINDING_PARAM);
        return next;
      },
      { replace: true }
    );
  }, [setSearchParams]);

  return useMemo(
    () => ({
      threadId,
      findingId,
      depth: threadId ? (findingId ? 2 : 1) : 0,
      openThread,
      back,
      closeAll,
    }),
    [back, closeAll, findingId, openThread, threadId]
  );
}
