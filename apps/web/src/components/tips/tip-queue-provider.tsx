import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

type TipQueueContextValue = {
  activeTipId: string | null;
  requestOpen: (tipId: string) => boolean;
  release: (tipId: string) => void;
};

const TipQueueContext = createContext<TipQueueContextValue>({
  activeTipId: null,
  requestOpen: () => false,
  release: () => {},
});

export function useTipQueue() {
  return useContext(TipQueueContext);
}

export function TipQueueProvider({ children }: { children: React.ReactNode }) {
  const [activeTipId, setActiveTipId] = useState<string | null>(null);
  const queueRef = useRef<string[]>([]);

  const requestOpen = useCallback(
    (tipId: string): boolean => {
      if (activeTipId === null) {
        setActiveTipId(tipId);
        return true;
      }
      if (activeTipId === tipId) return true;
      if (!queueRef.current.includes(tipId)) {
        queueRef.current.push(tipId);
      }
      return false;
    },
    [activeTipId]
  );

  const release = useCallback((tipId: string) => {
    setActiveTipId((current) => {
      if (current !== tipId) return current;
      const next = queueRef.current.shift() ?? null;
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ activeTipId, requestOpen, release }),
    [activeTipId, requestOpen, release]
  );

  return (
    <TipQueueContext.Provider value={value}>
      {children}
    </TipQueueContext.Provider>
  );
}
