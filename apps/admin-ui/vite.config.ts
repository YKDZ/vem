import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const apiProxyTarget =
  process.env.VEM_ADMIN_API_PROXY_TARGET ?? "http://localhost:3000";
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
const apiProxy = {
  "/api": {
    target: apiProxyTarget,
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    conditions: clientConditions,
    alias: {
      "@": resolve(import.meta.dirname, "src"),
    },
  },
  ssr: {
    noExternal: ["@vem/shared"],
    resolve: {
      conditions: serverConditions,
    },
  },
  server: {
    proxy: apiProxy,
  },
  preview: {
    proxy: apiProxy,
  },
  test: {
    include: ["src/**/*.{spec,test}.ts"],
    exclude: ["tests/**"],
  },
});
