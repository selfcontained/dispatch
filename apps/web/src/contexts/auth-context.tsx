import { createContext, useContext } from "react";
import { type AuthState } from "@/components/app/types";

type AuthContextValue = {
  authState: AuthState;
  handleAuthenticated: () => void;
  handleLogout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthContextProvider = AuthContext.Provider;

export function useAuthContext(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuthContext must be used within AuthContextProvider");
  return ctx;
}
