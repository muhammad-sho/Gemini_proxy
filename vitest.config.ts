import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "web/src/**/*.test.ts", "web/src/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts", "web/src/**/*.ts", "web/src/**/*.tsx"],
      exclude: [
        "node_modules/",
        "dist/",
        "src/main.ts",
        "**/*.d.ts",
        "vitest.config.ts",
        "src/**/*.test.ts",
        "web/src/testHelpers.ts",
        "web/src/**/*.test.ts",
        "web/src/**/*.test.tsx",
        "web/src/main.tsx"
      ],
      thresholds: {
        // Global gate covers the whole repo incl. the dashboard UI, whose page
        // components are not unit-tested yet (~15% today). Raise these floors
        // as page tests land — components already covered sit at ~90%.
        statements: 12,
        lines: 12,
        functions: 45,
        branches: 55,
        // Server-only bar, enforced on top of the global gate.
        "src/**": {
          statements: 80,
          lines: 80,
          functions: 70,
          branches: 65
        }
      }
    },
    testTimeout: 10000,
    hookTimeout: 10000
  }
});
