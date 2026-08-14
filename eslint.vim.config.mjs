import tsParser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "release/**", "src/vendor/**"],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/vim/**/*.ts", "src/vim-host/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
];
