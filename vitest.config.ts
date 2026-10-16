import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Integration tests share one database; run files sequentially.
    fileParallelism: false,
  },
});
