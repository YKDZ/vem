import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["vem-source"],
  },
  ssr: {
    noExternal: ["@vem/shared"],
    resolve: {
      conditions: ["vem-source"],
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
