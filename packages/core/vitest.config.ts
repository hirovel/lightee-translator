import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)));

export default defineConfig({
  test: {
    // 兜底清扫本次运行残留的临时目录（见 scripts/vitest-temp-sweep.ts）
    globalSetup: [resolve(packageRoot, "../../scripts/vitest-temp-sweep.ts")],
  },
});
