import { checkouts } from "./checkouts.mjs";
import { product } from "./product.mjs";
import { regressions } from "./regressions.mjs";
import { sessions } from "./sessions.mjs";
import { upgrades } from "./upgrades.mjs";

// A new scenario goes on the end of its group: the position names its scratch
// database and directory, and nothing else.
export const scenarios = [
  ...regressions,
  ...sessions,
  ...checkouts,
  ...product,
  ...upgrades,
];
