import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@vem/shared/schemas/maintenance-access": fileURLToPath(
        new URL(
          "../../packages/shared/src/schemas/maintenance-access.ts",
          import.meta.url,
        ),
      ),
    },
    conditions: ["vem-source"],
  },
  test: {
    include: ["src/**/*.spec.ts"],
  },
});
