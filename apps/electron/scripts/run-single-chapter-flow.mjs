/**
 * 拉起无头 Electron 跑单章全流程实测。
 *
 * 隔离面只有 `LIGHTEE_WORKSPACE_REGISTRY`：**不加** `--user-data-dir`、
 * **不加** `LIGHTEE_CONFIG_DIR`——它们会把真实 `~/.lightee` 一起隔离掉，
 * 于是拿不到 DPAPI 封存的密钥，也拿不到已配好的模型。
 *
 * 用法：node scripts/run-single-chapter-flow.mjs <txt/md/epub 路径>
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

if (!process.argv[2]) {
  console.error("用法：node scripts/run-single-chapter-flow.mjs <txt/md/epub 路径>");
  process.exit(1);
}
const sourcePath = resolve(process.argv[2]);
if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
  console.error(`源文件不存在或不是文件：${sourcePath}`);
  process.exit(1);
}
if (!existsSync(electronPath)) { console.error("electron 二进制不存在，先跑 npm ci"); process.exit(1); }

const registry = join(await mkdtemp(join(tmpdir(), "lightee-flow-reg-")), "workspaces.json");

const child = spawn(electronPath, [appRoot], {
  cwd: appRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    LIGHTEE_ALLOW_MULTI_INSTANCE: "1",
    LIGHTEE_WORKSPACE_REGISTRY: registry,
    LIGHTEE_HEADLESS_SCRIPT: join(appRoot, "scripts", "single-chapter-flow.mjs"),
    LIGHTEE_FLOW_SOURCE: sourcePath,
  },
});
child.on("exit", (code) => process.exit(code ?? 1));
