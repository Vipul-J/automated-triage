import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  // .mjs helper scripts sit outside the TypeScript project, so the typed rules
  // cannot resolve them.
  { ignores: ["node_modules/", "dist/", "*.config.js", "**/*.mjs"] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,

  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Unused values are almost always a mistake; a leading _ is the escape hatch.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Every await should be on something thenable - catches a dropped async.
      "@typescript-eslint/await-thenable": "error",
      // A floating promise in a deadline-driven pipeline is a silently lost ticket.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "no-console": ["error", { allow: ["error"] }],
      eqeqeq: ["error", "always"],
      "prefer-const": "error",
      "no-var": "error",
    },
  },

  {
    // Tools are operator-facing CLIs; printing to stdout is their whole job.
    files: ["tools/**/*.ts"],
    rules: { "no-console": "off" },
  },

  {
    // Fastify's contract is that a handler returning a value is async, whether
    // or not it awaits - the return value becomes the reply body.
    files: ["src/web/server.ts", "tools/simulator/server.ts"],
    rules: { "@typescript-eslint/require-await": "off" },
  },

  {
    // node:test's describe() and it() return promises that the runner owns;
    // awaiting them in a test file would be wrong, not safer.
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
);
