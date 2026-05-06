import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [vue(), tailwindcss()],

  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
    },
  },

  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/mqtt-ws": {
        target: "ws://172.31.0.2:9001",
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/mqtt-ws/, ""),
      },
    },
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
