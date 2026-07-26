import { defineConfig } from "vitest/config";

const serverConditions = [
  "vem-source",
  "module",
  "node",
  "development|production",
];

export default defineConfig({
  resolve: {
    conditions: serverConditions,
  },
  ssr: {
    noExternal: ["@vem/db", "@vem/shared"],
    resolve: {
      conditions: serverConditions,
    },
  },
  test: {
    exclude: [
      "**/*.e2e-spec.ts",
      "**/*.postgres.integration.spec.ts",
      "**/node_modules/**",
      "**/dist/**",
    ],
  },
});
