import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "frontend",
  publicDir: "../public",
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    allowedHosts: [".us1.manus.computer"],
    proxy: {
      "/api/v1": {
        target:
          process.env.GRADEFLOW_API_PROXY_TARGET || "http://127.0.0.1:8000",
        changeOrigin: false,
      },
      "/health": {
        target:
          process.env.GRADEFLOW_API_PROXY_TARGET || "http://127.0.0.1:8000",
        changeOrigin: false,
      },
      "/ready": {
        target:
          process.env.GRADEFLOW_API_PROXY_TARGET || "http://127.0.0.1:8000",
        changeOrigin: false,
      },
    },
  },
  build: { outDir: "../frontend/dist", emptyOutDir: true },
  test: { environment: "jsdom", setupFiles: "./src/test-setup.ts" },
});
