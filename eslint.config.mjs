import tsParser from "@typescript-eslint/parser";
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  globalIgnores([
    "node_modules/**",
    "dist/**",
    "release/**",
    "src/vendor/**",
    "tests/**",
    "scripts/**",
  ]),

  ...obsidianmd.configs.recommended,

  {
    files: ["main.ts", "src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
]);
