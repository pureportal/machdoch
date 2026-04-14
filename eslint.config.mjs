import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const sharedGlobals = {
  ...globals.browser,
  ...globals.es2022,
  ...globals.node,
};

export default tseslint.config(
  {
    ignores: [
      "coverage/**",
      "dist/**",
      "node_modules/**",
      "src-tauri/target/**",
    ],
  },
  {
    files: ["src/**/*.{ts,tsx}", "*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: sharedGlobals,
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["src/**/*.spec.ts", "src/**/*.test.{ts,tsx}", "vitest*.ts"],
    languageOptions: {
      globals: {
        ...sharedGlobals,
        ...globals.vitest,
      },
    },
  },
);
