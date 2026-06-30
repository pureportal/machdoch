import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const sharedGlobals = {
  ...globals.browser,
  ...globals.es2022,
  ...globals.node,
};

const generatedAndBuildIgnores = [
  "coverage/**",
  "dist/**",
  "node_modules/**",
  "src-tauri/target/**",
];

const configJavaScriptFiles = ["eslint.config.mjs"];
const sourceTypeScriptFiles = ["src/**/*.{ts,tsx}", "*.ts"];
const testTypeScriptFiles = [
  "src/**/*.spec.ts",
  "src/**/*.test.{ts,tsx}",
  "vitest*.ts",
];

export default tseslint.config(
  {
    ignores: generatedAndBuildIgnores,
  },
  {
    files: configJavaScriptFiles,
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: sharedGlobals,
    },
  },
  {
    files: sourceTypeScriptFiles,
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
    files: testTypeScriptFiles,
    languageOptions: {
      globals: {
        ...sharedGlobals,
        ...globals.vitest,
      },
    },
  },
);
