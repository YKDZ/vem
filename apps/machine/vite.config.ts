import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const host = process.env.TAURI_DEV_HOST;
const clientConditions = [
  "vem-source",
  "module",
  "browser",
  "development|production",
];
const serverConditions = [
  "vem-source",
  "module",
  "node",
  "development|production",
];

export default defineConfig({
  plugins: [vue(), tailwindcss()],

  resolve: {
    conditions: clientConditions,
    alias: {
      "@": resolve(import.meta.dirname, "src"),
    },
  },

  ssr: {
    noExternal: ["@vem/shared", "vision-mock"],
    resolve: {
      conditions: serverConditions,
    },
  },

  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },

  test: {
    include: ["src/**/*.{spec,test}.ts"],
    environment: "node",
  },
});
