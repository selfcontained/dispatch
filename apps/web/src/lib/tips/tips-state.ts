import { atomWithLocalStorage } from "../store";

export const tipsEnabledAtom = atomWithLocalStorage(
  "dispatch:tipsEnabled",
  true
);

export const dismissedTipsAtom = atomWithLocalStorage<string[]>(
  "dispatch:dismissedTips",
  []
);

export const lastSeenVersionAtom = atomWithLocalStorage<string | null>(
  "dispatch:lastSeenVersion",
  null
);
