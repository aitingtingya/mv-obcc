import tsParser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "release/**"],
  },
  {
    files: ["main.ts", "src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      obsidianmd,
    },
    rules: {
      "obsidianmd/no-static-styles-assignment": "error",
      "obsidianmd/no-unsupported-api": "error",
      "obsidianmd/settings-tab/no-manual-html-headings": "error",
      "obsidianmd/validate-license": "error",
      "obsidianmd/validate-manifest": "error",
    },
  },
];
