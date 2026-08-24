import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/", "dist/", "src/main.ts", "**/*.d.ts"]
    },
    testTimeout: 10000,
    hookTimeout: 10000
  }
});