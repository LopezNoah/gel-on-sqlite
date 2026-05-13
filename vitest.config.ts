import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      GEL_EXPERIMENTAL_GEL_IR_SQL_LOWERING: "true",
      GEL_SQLITE_IR_FIRST: "1",
    },
  },
});
