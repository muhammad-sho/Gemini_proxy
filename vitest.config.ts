import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "node_modules/",
        "dist/",
        "src/main.ts",
        "**/*.d.ts",
        "vitest.config.ts",
        "src/**/*.test.ts"
      ],
      thresholds: {
        statements: 80,
        lines: 80,
        functions: 70,
        branches: 65
      }
    },
    testTimeout: 10000,
    hookTimeout: 10000
  }
});
