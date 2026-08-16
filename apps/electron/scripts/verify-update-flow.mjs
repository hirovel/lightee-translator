/**
 * 更新闭环端到端验证：装出去的旧版真的能发现新版、下载、装上吗？
 *
 * 这条链路此前从未被验证过。它一旦坏掉是**静默**的——electron-updater 的
 * checkForUpdates 失败会被 main.js 吞掉（"Update availability must never
 * prevent the application from starting"，这个吞是故意的，别处不该改），
 * 用户只是永远收不到更新，没有任何报错提示他们。RL-05 刚把 releaseType
 * 那类"字段写错、更新器找不到版本"的问题堵过一次，但闭环本身——旧版真的
 * 收到新版并装上——始终是理论上成立、从没跑过一次的假设。
 *
 * 用法：
 *   1. 先用两个临时版本号（避免污染 0.10 语义）分别打包，两次都指向本脚本
 *      即将起的本地 generic provider：
 *        npx electron-builder --win nsis --publish never \
 *          -c.directories.output=verify-update/old-out \
 *          -c.extraMetadata.version=0.9.90 \
 *          -c.publish.provider=generic -c.publish.url=http://127.0.0.1:8099/
 *        npx electron-builder --win nsis --publish never \
 *          -c.directories.output=verify-update/new-out \
 *          -c.extraMetadata.version=0.9.91 \
 *          -c.publish.provider=generic -c.publish.url=http://127.0.0.1:8099/
 *   2. node scripts/verify-update-flow.mjs
 *
 * 流程：起本地静态服务器托管「新版」产物 → 静默装「旧版」→ 启动 →
 * 轮询 AppLog 等 update-downloaded → 关闭应用触发 autoInstallOnAppQuit →
 * 轮询注册表 DisplayVersion 直到变成新版本号 → 卸载 → 核对 ~/.lightee 未动。
 *
 * 全程只用 127.0.0.1，不接触任何真实发布渠道；用同一个 appId 才能测到
 * NSIS 更新覆盖安装的真实行为，这是刻意的，不是遗留问题。
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OLD_VERSION = "0.9.90";
const NEW_VERSION = "0.9.91";
const PORT = 8099;
const TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const oldOutDir = join(appRoot, "verify-update", "old-out");
const newOutDir = join(appRoot, "verify-update", "new-out");
const oldInstaller = join(oldOutDir, `Lightee-${OLD_VERSION}-win-x64-setup.exe`);

const installDir = join(process.env.LOCALAPPDATA, "Programs", "Lightee");
const lightee_exe = join(installDir, "Lightee.exe");
const uninstaller = join(installDir, "Uninstall Lightee.exe");
// userData 目录不是 productName（"Lightee"），是打包后 package.json 的 name 字段
// （"lightee-electron"）——electron-builder 不会自动把两者对齐。第二轮演练在这里
// 栽过一次：AppLog 其实立刻就写了 update-downloaded，脚本却因为查错目录空等了
// 整整 5 分钟才超时，被误判成「更新流程卡住/崩溃」。
const appLogDir = join(process.env.APPDATA, "lightee-electron", "logs");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollUntil(description, checkFn, timeoutMs = TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await checkFn();
    if (result) {
      log(`${description} —— 就绪（耗时 ${Math.round((Date.now() - start) / 1000)}s）`);
      return result;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`${description} —— 超时（${timeoutMs / 1000}s）`);
}

function psQuery(cmd) {
  const r = spawnSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" });
  return r.stdout.trim();
}

function registryDisplayVersion() {
  const out = psQuery(
    `Get-ChildItem "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall" -ErrorAction SilentlyContinue | ` +
      `ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like "*Lightee*" } | ` +
      `Select-Object -ExpandProperty DisplayVersion`,
  );
  return out || null;
}

/**
 * AppLog 是按天追加的文件，不会因为重跑演练而清空——第四轮演练就在这里栽过：
 * 前几轮留下的 "update downloaded" 字样还在同一份日志里，轮询一开始就命中，
 * 于是在这一轮真正的下载请求发出之前就误判"成功"并提前关闭了应用。
 * 只认脚本本轮启动之后写入的行，用日志每行开头的 ISO 时间戳过滤。
 */
async function appLogLinesSince(sinceMs) {
  if (!existsSync(appLogDir)) return "";
  const files = readdirSync(appLogDir).filter((f) => f.startsWith("lightee-") && f.endsWith(".log"));
  if (!files.length) return "";
  const newest = files
    .map((f) => ({ f, mtime: statSync(join(appLogDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].f;
  const content = await readFile(join(appLogDir, newest), "utf8").catch(() => "");
  return content
    .split("\n")
    .filter((line) => {
      const ts = Date.parse(line.slice(0, 24));
      return !Number.isNaN(ts) && ts >= sinceMs;
    })
    .join("\n");
}

function startUpdateServer() {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      // electron-updater 请求 latest.yml 时会带 ?noCache=<随机> 破缓存查询串，
      // 必须先剥掉查询串再当文件名用，否则找不到文件——这正是第一次演练 404 的原因。
      const pathname = new URL(req.url, "http://127.0.0.1").pathname;
      const filePath = join(newOutDir, decodeURIComponent(pathname.replace(/^\//, "")));
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        res.writeHead(404);
        res.end();
        log(`本地更新服务器：404 ${req.url}`);
        return;
      }
      log(`本地更新服务器：served ${req.url}`);
      res.writeHead(200);
      createReadStream(filePath).pipe(res);
    });
    server.listen(PORT, "127.0.0.1", () => resolvePromise(server));
  });
}

async function main() {
  if (!existsSync(oldInstaller)) {
    console.error(`找不到旧版安装包：${oldInstaller}\n先按脚本头部注释打好两个临时版本。`);
    process.exit(1);
  }
  const newYml = join(newOutDir, "latest.yml");
  if (!existsSync(newYml)) {
    console.error(`找不到新版 latest.yml：${newYml}`);
    process.exit(1);
  }

  log(`新版清单内容：\n${await readFile(newYml, "utf8")}`);

  log("起本地更新服务器 127.0.0.1:" + PORT);
  const server = await startUpdateServer();

  try {
    log(`静默安装旧版 ${OLD_VERSION}：${oldInstaller}`);
    spawnSync(oldInstaller, ["/S"], { stdio: "inherit" });

    await pollUntil("旧版安装完成", () => existsSync(lightee_exe) && existsSync(uninstaller));
    const installedVersionBefore = registryDisplayVersion();
    log(`安装后注册表版本：${installedVersionBefore}`);
    if (installedVersionBefore !== OLD_VERSION) {
      throw new Error(`安装后版本号是「${installedVersionBefore}」，应为「${OLD_VERSION}」——安装本身就不对，更新测不下去`);
    }

    log("启动旧版，触发它自己的 checkForUpdates");
    // 第一轮演练用 stdio:"ignore" 吞掉了子进程的一切输出——如果 Electron 主进程真的因
    // 未捕获异常崩溃，现场就随之消失，只留下"5 分钟后超时"这一个没有信息量的事实。
    // 改成落盘，进程真崩了立刻能看见 stack。
    const appLogFile = join(appRoot, "verify-update", "app-stdio.log");
    const { openSync } = await import("node:fs");
    const stdioFd = openSync(appLogFile, "w");
    const runStartedAt = Date.now();
    const appProcess = spawn(lightee_exe, [], { detached: true, stdio: ["ignore", stdioFd, stdioFd] });
    appProcess.unref();

    await pollUntil("AppLog 出现本轮的 update-downloaded 记录（或应用中途退出/报错）", async () => {
      const tail = await appLogLinesSince(runStartedAt);
      if (tail.includes("update downloaded")) return tail;
      if (tail.includes("self-update failed")) {
        throw new Error(`更新过程报错，AppLog 原文：\n${tail}`);
      }
      const stillAlive = psQuery('(Get-Process -Name Lightee -ErrorAction SilentlyContinue | Measure-Object).Count');
      if (stillAlive === "0") {
        const stdioTail = await readFile(appLogFile, "utf8").catch(() => "(读不到)");
        throw new Error(`应用进程已经不在了（非预期退出，还没到关闭触发安装那一步）。子进程 stdio 原文：\n${stdioTail}`);
      }
      return null;
    });

    log("关闭应用以触发 autoInstallOnAppQuit（静默重装为新版）");
    spawnSync("powershell", ["-NoProfile", "-Command", "Get-Process -Name Lightee -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }"]);
    await sleep(3000);
    spawnSync("powershell", ["-NoProfile", "-Command", "Get-Process -Name Lightee -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"]);

    const finalVersion = await pollUntil("注册表版本变为新版", () => {
      const v = registryDisplayVersion();
      return v === NEW_VERSION ? v : null;
    });

    log(`✅ 更新闭环验证通过：${OLD_VERSION} → ${finalVersion}`);
  } finally {
    server.close();
    log("清理：卸载、核对残留");
    if (existsSync(uninstaller)) {
      spawnSync(uninstaller, ["/currentuser", "/S"], { stdio: "inherit" });
      await pollUntil("卸载完成", () => !existsSync(lightee_exe));
    }
    if (existsSync(installDir)) {
      await rm(installDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

await main();
