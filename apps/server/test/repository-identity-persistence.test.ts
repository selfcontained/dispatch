import { expect, it } from "vitest";
import { repositoryRecord } from "../src/runners/repository-identity.js";
import {
  controllerPlacement,
  placementForRunner,
} from "../src/runners/placement.js";

it("preserves main local repository object and serialized bytes", () => {
  const raw = {
    url: "https://EXAMPLE.com:443/org/../repo.git",
    checkout: { kind: "default" },
  };
  expect(repositoryRecord(controllerPlacement, raw)).toBe(raw);
  expect(JSON.stringify(repositoryRecord(controllerPlacement, raw))).toBe(
    JSON.stringify(raw)
  );
});
it.each([
  ["https://EXAMPLE.com:443/org/../repo.git", "https://example.com/repo"],
  ["https://example.com/%2e%2e/repo.git", "https://example.com/repo"],
  ["https://example.com/repo.git///", "https://example.com/repo"],
  ["https://example.com/.git", "https://example.com/"],
  ["git@example.com:org/repo.git", null],
])(
  "persists canonical identity without changing clone URL %s",
  (url, identityKey) => {
    expect(repositoryRecord(placementForRunner("fixture"), { url })).toEqual({
      url,
      identityKey,
    });
  }
);
