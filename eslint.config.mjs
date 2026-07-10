// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

// Flat config, shared by every workspace package. ESLint walks up from each
// package dir and finds this file, so `eslint .` behaves identically everywhere.
export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/build/**", "**/out/**", "**/.turbo/**", "**/node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    // TypeScript itself checks for undefined identifiers; the core ESLint rule
    // only produces false positives against types and ambient globals.
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
