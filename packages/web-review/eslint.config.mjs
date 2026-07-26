import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "**/dist/**", "node_modules/**"],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
