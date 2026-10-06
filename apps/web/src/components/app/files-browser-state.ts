import { atomFamily } from "jotai/utils";
import { atomWithLocalStorage } from "@/lib/store";

export type FilesBrowserState = {
  expanded: string[];
  filter: string;
  browse: boolean | null;
  treeTop: number;
  searchTop: number;
};
const initial: FilesBrowserState = {
  expanded: [""],
  filter: "",
  browse: null,
  treeTop: 0,
  searchTop: 0,
};
function valid(value: unknown): value is FilesBrowserState {
  if (!value || typeof value !== "object") return false;
  const v = value as FilesBrowserState;
  return (
    Array.isArray(v.expanded) &&
    v.expanded.length <= 32 &&
    v.expanded.includes("") &&
    v.expanded.every((p) => typeof p === "string") &&
    typeof v.filter === "string" &&
    (v.browse === null || typeof v.browse === "boolean") &&
    Number.isFinite(v.treeTop) &&
    v.treeTop >= 0 &&
    Number.isFinite(v.searchTop) &&
    v.searchTop >= 0
  );
}
// Feature-owned persistence, isolated per agent/workspace; no route-level state.
export const filesBrowserStateFamily = atomFamily((key: string) =>
  atomWithLocalStorage<FilesBrowserState>(
    `dispatch:filesBrowser:${key}`,
    initial,
    { validate: valid }
  )
);
