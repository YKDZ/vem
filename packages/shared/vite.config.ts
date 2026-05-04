import { resolve } from "node:path";
import dts from "unplugin-dts/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts", "src/**/*.test.ts"],
  },
  ssr: {
    // Externalize runtime dependencies — consumers provide their own copies.
    external: ["zod"],
  },

  build: {
    ssr: true,
    emptyOutDir: true,
    sourcemap: true,

    lib: {
      entry: resolve(import.meta.dirname, "src/index.ts"),
      formats: ["es", "cjs"],
    },

    rolldownOptions: {
      output: {
        // Preserve the original module structure so tree-shaking works for
        // consumers (Vite / admin-ui) and import paths are correct.
        preserveModules: true,
        preserveModulesRoot: resolve(import.meta.dirname, "src"),
      },
    },
  },

  plugins: [
    dts({
      tsconfigPath: resolve(import.meta.dirname, "tsconfig.lib.json"),
    }),
  ],
});
