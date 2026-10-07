/** The human identity shared by a Dispatch instance. */
export const USER_AVATAR_PRESETS = [
  "person",
  "sun",
  "cat",
  "leaf",
  "mountain",
  "coffee",
] as const;
export type UserAvatarPreset = (typeof USER_AVATAR_PRESETS)[number];
export type UserAvatar =
  | { kind: "builtin"; id: UserAvatarPreset }
  | { kind: "image"; dataUrl: string };
export const DEFAULT_USER_AVATAR: UserAvatar = {
  kind: "builtin",
  id: "person",
};
export const USER_AVATAR_MAX_BYTES = 100_000;
export const USER_AVATAR_SIZE = 256;
