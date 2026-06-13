import { createContext } from "react";

import { type AuthState } from "@/components/app/types";

export type AuthContextValue = {
  authState: AuthState;
  handleAuthenticated: () => void;
  handleLogout: () => Promise<void>;
  retryAuth: () => void;
};

export const AuthContext = createContext<AuthContextValue | null>(null);
