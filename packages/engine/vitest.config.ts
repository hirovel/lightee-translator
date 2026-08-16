import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)));

export default defineConfig({
  test: {
    // 兜底清扫本次运行残留的临时目录（见 scripts/vitest-temp-sweep.ts）
    globalSetup: [resolve(packageRoot, "../../scripts/vitest-temp-sweep.ts")],

    // 本包的测试大量走**真实文件系统**（mkdtemp 建工作区、写几十个小文件），
    // 而文件系统的快慢在不同环境里差一个数量级：本机 63 个用例 2.34s 跑完，
    // 同一批在带 Defender 的 Windows CI runner 上会把 beforeEach 拖过 10s 默认值，
    // 于是 2026-08-16 的发布构建挂在 "Hook timed out in 10000ms"，随后清理撞上
    // 仍在飞的写入又报 ENOTEMPTY——超时是因，ENOTEMPTY 是连带的果。
    //
    // 放宽到 30s 不是把问题盖住：本地实测单个文件 200ms–1.7s，30s 有约 20 倍余量，
    // 而真正的死锁/挂起照样会撞到 30s 并失败，只是不再因为「机器今天慢」而随机红。
    // 发布构建里跑着这套测试，随机红等于一个想发就发不出去的版本。
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
