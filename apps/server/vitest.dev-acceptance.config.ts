import { defineConfig } from "vitest/config";
import base from "./vitest.config";

// Explicit acceptance command only: full API/Vite/DB/host restart validation.
// The ordinary test glob intentionally does not collect *.acceptance.ts.
export default defineConfig({
  ...base,
  test: { ...base.test, include: ["test/dispatch-dev.acceptance.ts"] },
});
