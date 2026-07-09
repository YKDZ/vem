import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["vem-source"],
  },
  ssr: {
    noExternal: ["@vem/db", "@vem/shared"],
    resolve: {
      conditions: ["vem-source"],
    },
  },
});
