import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: "../dist-web",
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:18765",
      "/v1beta": "http://localhost:18765",
      "/health": "http://localhost:18765"
    }
  }
});
