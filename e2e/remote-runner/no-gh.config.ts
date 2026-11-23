import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Opt-in diagnostic only; the normal lane matches *.spec.ts.
export default defineConfig({ ...base, testMatch: "no-gh.probe.ts" });
