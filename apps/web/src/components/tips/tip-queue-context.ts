import { createContext, useContext } from "react";

export type TipQueueContextValue = {
  activeTipId: string | null;
  requestOpen: (tipId: string) => boolean;
  release: (tipId: string) => void;
};

export const TipQueueContext = createContext<TipQueueContextValue>({
  activeTipId: null,
  requestOpen: () => false,
  release: () => {},
});

export function useTipQueue() {
  return useContext(TipQueueContext);
}
