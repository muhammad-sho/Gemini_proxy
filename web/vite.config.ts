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
      // Dashboard talks only to the admin surface (default port 18765).
      "/api": "http://localhost:18765",
      "/health": "http://localhost:18765"
    }
  }
});
