import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const apiProxyTarget =
  process.env.VEM_ADMIN_API_PROXY_TARGET ?? "http://localhost:3000";

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    conditions: ["vem-source"],
    alias: {
      "@": resolve(import.meta.dirname, "src"),
    },
  },
  ssr: {
    noExternal: ["@vem/shared"],
    resolve: {
      conditions: ["vem-source"],
    },
  },
  server: {
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
  test: {
    include: ["src/**/*.{spec,test}.ts"],
    exclude: ["tests/**"],
  },
});
