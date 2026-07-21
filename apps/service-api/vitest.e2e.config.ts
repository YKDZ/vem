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
    include: ["src/**/*.e2e-spec.ts"],
    fileParallelism: false,
  },
});
