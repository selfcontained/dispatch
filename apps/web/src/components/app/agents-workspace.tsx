import { useEffect } from "react";

export function AgentsWorkspace({
  children,
  onUnmount,
}: {
  children: React.ReactNode;
  onUnmount: () => void;
}): JSX.Element {
  useEffect(() => {
    return () => {
      onUnmount();
    };
  }, [onUnmount]);

  return <>{children}</>;
}
