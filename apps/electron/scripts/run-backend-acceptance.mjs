/**
 * 拉起无头 Electron 跑后端验收。
 *
 * 隔离面只有 `LIGHTEE_WORKSPACE_REGISTRY`：**不加** `--user-data-dir`、
 * **不加** `LIGHTEE_CONFIG_DIR`——它们会把真实 `~/.lightee` 一起隔离掉，
 * 于是拿不到 DPAPI 封存的密钥，也拿不到已配好的模型。
 *
 * 用法：node scripts/run-backend-acceptance.mjs <epub 路径> [章数，默认 3]
 */
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const electronPath = join(appRoot, "node_modules", "electron", "dist", "electron.exe");

// 漏传参数要当场说清楚。此前写的是 `resolve(process.argv[2] ?? "")`：
// 没传参时 resolve("") 返回 cwd，而 cwd 是个存在的**目录**，existsSync 照样放行，
// 于是错误一路飘到导入环节，变成「不支持的格式 .c:\...\apps\electron」——
// 一个把「你忘了传参」伪装成格式问题的报错，查起来要绕一大圈。
if (!process.argv[2]) {
  console.error("用法：node scripts/run-backend-acceptance.mjs <epub/txt/md 路径> [章数，默认 3]");
  process.exit(1);
}
const sourcePath = resolve(process.argv[2]);
const chapters = process.argv[3] ?? "3";
if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
  console.error(`源文件不存在或不是文件：${sourcePath}`);
  process.exit(1);
}
if (!existsSync(electronPath)) { console.error("electron 二进制不存在，先跑 npm ci"); process.exit(1); }

const registry = join(await mkdtemp(join(tmpdir(), "lightee-backend-reg-")), "workspaces.json");

const child = spawn(electronPath, [appRoot], {
  cwd: appRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    LIGHTEE_ALLOW_MULTI_INSTANCE: "1",
    LIGHTEE_WORKSPACE_REGISTRY: registry,
    LIGHTEE_HEADLESS_SCRIPT: join(appRoot, "scripts", "backend-acceptance.mjs"),
    LIGHTEE_ACCEPT_SOURCE: sourcePath,
    LIGHTEE_ACCEPT_CHAPTERS: String(chapters),
  },
});
child.on("exit", (code) => process.exit(code ?? 1));
