import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      react.configs.flat["jsx-runtime"],
    ],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs["recommended-latest"].rules,
      // Upgrade hook dependency warnings to errors so CI catches them
      "react-hooks/exhaustive-deps": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      // The app supports plain HTTP LAN installs. These browser APIs require
      // a secure context; use the shared client ID helper for identifiers.
      // Omitting `object` also catches aliases, computed keys and destructuring.
      "no-restricted-properties": [
        "error",
        {
          property: "randomUUID",
          message:
            "Use createClientId from @/lib/client-id; randomUUID requires HTTPS.",
        },
        {
          property: "subtle",
          message:
            "SubtleCrypto requires HTTPS; web client code must support plain HTTP.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: ["crypto", "node:crypto"],
        },
      ],
      // Empty catch blocks are used intentionally to silence expected errors (e.g. socket.close())
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Allow _-prefixed names to signal intentionally unused destructured values
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  }
);
