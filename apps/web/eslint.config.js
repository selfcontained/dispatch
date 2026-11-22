import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import dispatch from "./eslint-design-tokens.js";

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
    },
    rules: {
      ...reactHooks.configs["recommended-latest"].rules,
      // Upgrade hook dependency warnings to errors so CI catches them
      "react-hooks/exhaustive-deps": "error",
      "react-hooks/rules-of-hooks": "error",
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
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}", "src/components/ui/toast.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "crypto",
            "node:crypto",
            {
              name: "sonner",
              message:
                "Use toast from @/components/ui/toast, which keeps the one card, host and stack.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.name=/^(window|globalThis)$/][callee.property.name=/^(confirm|prompt|alert)$/]",
          message:
            "Use ConfirmDialog, a Dialog with a Field, or an Alert from components/ui, not a native dialog.",
        },
      ],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    plugins: { dispatch },
    // No exceptions today. A new one is { file, token }, naming the one file
    // and the one class, with a comment saying why no token fits.
    rules: { "dispatch/design-tokens": ["error", { allow: [] }] },
  },
  {
    files: ["src/**/*.tsx"],
    // components/ui defines the controls. The stream moves onto them in
    // design-system task 5/6, which drops its ignore here and the exceptions.
    ignores: [
      "**/*.test.tsx",
      "src/components/ui/**",
      "src/components/app/chat/**",
    ],
    plugins: { dispatch },
    rules: {
      "dispatch/controls": [
        "error",
        {
          allow: [
            // The diff's Add comment split button moves to SplitButton in 5/6.
            { file: "diff-comment-form.tsx", id: "rawButton" },
            // Effort's compact form is a chip in the composer's meta row.
            { file: "effort-picker.tsx", id: "streamSize" },
          ],
        },
      ],
    },
  }
);
