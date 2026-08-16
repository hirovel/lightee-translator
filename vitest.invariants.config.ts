import { defineConfig } from "vitest/config";

/**
 * 架构不变量测试（IV-01）。独立于三个包的 vitest 工作区：它扫的是**整个仓库的源码文本**，
 * 不属于任何一个包。根 `npm test` 会跑它。
 */
export default defineConfig({
  test: {
    include: ["tests/invariants/**/*.test.ts"],
    environment: "node",
  },
});
