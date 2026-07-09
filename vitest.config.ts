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
    noExternal: ["@vem/shared"],
    resolve: {
      conditions: serverConditions,
    },
  },
  test: {
    server: {
      deps: {
        inline: ["@vem/shared"],
      },
    },
  },
});
