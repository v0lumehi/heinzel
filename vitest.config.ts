import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Integration tests share one database; run files sequentially.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Entry points and CLIs are exercised end to end, not by unit tests.
      exclude: ["src/index.ts", "src/**/cli.ts", "src/adapters/teams/package-cli.ts", "src/admin/types.ts"],
      reporter: ["text-summary", "lcov", "json-summary"],
    },
  },
});
