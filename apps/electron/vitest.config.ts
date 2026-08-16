import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)));

export default defineConfig({
  root: appRoot,
  test: {
    include: ["renderer/src/**/*.test.ts", "shared/**/*.test.ts"],
    environment: "node",
    // 兜底清扫本次运行残留的临时目录（见 scripts/vitest-temp-sweep.ts）
    globalSetup: [resolve(appRoot, "../../scripts/vitest-temp-sweep.ts")],
  },
});
