import {
  AuthContext,
  type AuthContextValue,
} from "@/contexts/auth-context-core";

export function AuthContextProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: AuthContextValue;
}): JSX.Element {
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
