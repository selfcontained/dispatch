import type { ReactNode } from "react";
import { DEFAULT_USER_AVATAR } from "@dispatch/shared";
import { useUserAvatarQuery } from "@/hooks/use-user-avatar";
import { UserAvatarContext } from "./avatar-context";

/** One query subscription for all stream and thread avatars, not one per row. */
export function UserAvatarProvider({ children }: { children: ReactNode }) {
  const { data } = useUserAvatarQuery();
  return (
    <UserAvatarContext.Provider value={data?.avatar ?? DEFAULT_USER_AVATAR}>
      {children}
    </UserAvatarContext.Provider>
  );
}
