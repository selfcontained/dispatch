import { createContext, useContext } from "react";
import { DEFAULT_USER_AVATAR, type UserAvatar } from "@dispatch/shared";

export const UserAvatarContext = createContext<UserAvatar>(DEFAULT_USER_AVATAR);
export function useUserAvatar() {
  return useContext(UserAvatarContext);
}
