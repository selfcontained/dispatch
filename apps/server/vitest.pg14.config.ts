import { defineConfig } from "vitest/config";
import base from "./vitest.config";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    // dispatch-dev always provisions postgres:17 via docker-compose.yml;
    // TEST_DATABASE_URL does not select its database. The main suite still
    // runs this full-stack/restart coverage once. Repeating it here tests 17
    // again and dominates the compatibility run without checking PostgreSQL 14.
    exclude: [...(base.test?.exclude ?? []), "test/dispatch-dev.test.ts"],
  },
});
