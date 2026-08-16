/**
 * Scoop 安装渠道端到端验证：一行命令装出来的那一份，能装、能起、且不自己更新。
 *
 * 为什么值得单独验一遍：Scoop 渠道和 NSIS 渠道走的是两套完全不同的路径。
 * NSIS 装到 `%LOCALAPPDATA%\Programs\Lightee`，Scoop 装到 `<scoop 根>\apps\lightee\<版本>`，
 * 而 RL-05 的自更新判定正是靠 execPath 里那一段 `\scoop\apps\` 来区分的
 * （见 shared/package-manager-install.ts）。这个判定一旦失效，Scoop 装的那一份会去
 * 下载 setup.exe 并装出**第二份**到 Programs 目录：两份各自更新，`scoop list` 显示的
 * 版本从此和用户实际双击到的对不上。这种错是静默的，用户只会觉得「更新了个寂寞」。
 *
 * 唯一被替身顶掉的是下载地址：清单里的 URL 指向本脚本起的 127.0.0.1 静态服务器，
 * 而不是 GitHub Releases。除此之外——sha256 校验、解包、shim 生成、启动、
 * 自更新判定、卸载——全是真链路。发布后把 URL 换成真实地址即可，其余不动。
 *
 * 用法（先跑过 npm run package:win，release/ 里有 zip）：
 *   node scripts/verify-scoop-install.mjs
 *
 * 流程：算 zip 的 sha256 → 先用**错误**哈希装一次（必须失败，证明校验是生效的）→
 * 换正确哈希装 → 核对装到了 scoop 的 apps 目录、shim 可用 → 启动 →
 * 轮询 AppLog 确认写下了 self-update skipped: package-manager-install →
 * 关闭 → scoop uninstall → 核对 ~/.lightee 未被动过。
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.10.0";
const ZIP_NAME = `Lightee-${VERSION}-win-x64.zip`;
const PORT = 8100;
const BUCKET_NAME = "lightee-test";
const TIMEOUT_MS = 3 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 默认验本机产物；发布前应当指向下载下来的 CI 产物，验的才是用户真正会拿到的那一份。
const releaseDir = process.env.LIGHTEE_RELEASE_DIR || join(appRoot, "release");
const zipPath = join(releaseDir, ZIP_NAME);
const workDir = join(appRoot, "verify-scoop");

const scoopRoot = process.env.SCOOP || join(process.env.USERPROFILE, "scoop");
const scoopCmd = join(scoopRoot, "shims", "scoop.cmd");
const installedDir = join(scoopRoot, "apps", "lightee", "current");
const installedExe = join(installedDir, "Lightee.exe");
const shimPath = join(scoopRoot, "shims", "lightee.exe");
// userData 目录取的是打包后 package.json 的 name（lightee-electron），不是 productName。
const appLogDir = join(process.env.APPDATA, "lightee-electron", "logs");
const lighteeHome = join(process.env.USERPROFILE, ".lightee");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function sha256(file) {
  return new Promise((res, rej) => {
    const hash = createHash("sha256");
    createReadStream(file).on("error", rej).on("data", (d) => hash.update(d)).on("end", () => res(hash.digest("hex")));
  });
}

/**
 * 必须是异步 spawn，不能用 spawnSync——这是本脚本最容易踩、也最难看出来的一处。
 *
 * 托管产物的 HTTP 服务器就跑在**同一个进程**里。spawnSync 把 Node 的事件循环整个堵死，
 * 于是 scoop 发出的下载请求根本没人应答，它只能一路等到自己超时：
 *   Installing 'lightee' (0.10.0) [64bit] from 'lightee-test' bucket
 *   The operation has timed out.
 * 表象是「下载失败」，真因却在验证脚本这一侧——很容易反过来误判成产物或网络有问题。
 *
 * 另外要经 cmd.exe 转一手：Node 从 18.20/20.12 起（CVE-2024-27980）不再允许在
 * shell:false 下直接 spawn .cmd/.bat，那会带着 error 立刻返回、status 是 null。
 */
function runScoop(args, { allowFailure = false } = {}) {
  log(`scoop ${args.join(" ")}`);
  return new Promise((res, rej) => {
    const child = spawn(process.env.COMSPEC || "cmd.exe", ["/c", scoopCmd, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    // scoop 遇到需要确认的场面会去读 stdin，而这里给的是 ignore；挂死必须响，不能无声空等。
    const timer = setTimeout(() => {
      child.kill();
      rej(new Error(`scoop ${args.join(" ")} 超时（10 分钟）\n已收到的输出：\n${output}`));
    }, 10 * 60 * 1000);
    child.on("error", (err) => {
      clearTimeout(timer);
      rej(new Error(`scoop 无法执行：${err.message}`));
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      console.log(output.trimEnd());
      if (!allowFailure && status !== 0) {
        rej(new Error(`scoop ${args.join(" ")} 退出码 ${status}\n${output}`));
        return;
      }
      res({ status, output });
    });
  });
}

/** ~/.lightee 是用户的真实工作数据，任何渠道的安装/卸载都不该碰它。只读快照，不动内容。 */
function homeSnapshot() {
  if (!existsSync(lighteeHome)) return "(不存在)";
  return readdirSync(lighteeHome)
    .map((n) => {
      const s = statSync(join(lighteeHome, n));
      return `${n}:${s.isDirectory() ? "dir" : s.size}`;
    })
    .sort()
    .join("|");
}

/**
 * AppLog 按天追加、不会因重跑而清空，所以只认本轮启动之后写入的行——
 * 否则上一轮留下的同样字样会让轮询立刻误判成功（RL-08 就栽过这一次）。
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

function startServer() {
  return new Promise((res) => {
    const server = createServer((req, resp) => {
      const pathname = new URL(req.url, "http://127.0.0.1").pathname;
      const filePath = join(releaseDir, decodeURIComponent(pathname.replace(/^\//, "")));
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        resp.writeHead(404);
        resp.end();
        log(`本地服务器：404 ${req.url}`);
        return;
      }
      log(`本地服务器：served ${req.url}`);
      resp.writeHead(200, { "Content-Length": statSync(filePath).size });
      createReadStream(filePath).pipe(resp);
    });
    // 端口被占时 listen 会抛 EADDRINUSE 的未捕获 error 事件，直接崩成一屏和本次演练
    // 无关的 net 栈堆栈。说清楚是什么占了、怎么办，比堆栈有用。
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.error(`127.0.0.1:${PORT} 已被占用——多半是上一轮演练的服务器还活着。先把它关掉再跑。`);
        process.exit(1);
      }
      throw err;
    });
    server.listen(PORT, "127.0.0.1", () => res(server));
  });
}

function manifestJson(hash) {
  return `${JSON.stringify(
    {
      version: VERSION,
      description: "AI Agent 辅助翻译的日文轻小说工作台",
      homepage: "https://github.com/hirovel/lightee-translator",
      license: "AGPL-3.0",
      architecture: { "64bit": { url: `http://127.0.0.1:${PORT}/${ZIP_NAME}`, hash } },
      bin: "Lightee.exe",
      shortcuts: [["Lightee.exe", "Lightee"]],
    },
    null,
    2,
  )}\n`;
}

/**
 * 起一个**真的** bucket，而不是把清单文件路径直接喂给 scoop install。
 *
 * 用户真正会敲的是 `scoop install lightee`：scoop 先解析 bucket，再去 bucket/ 下找同名清单。
 * 那套目录布局本身就是 RL-06 要交付的东西，走一遍等于顺带把它验掉；而把清单路径直接
 * 喂给 scoop install 走的是另一条分支，验了也不算数。
 */
function setupBucket() {
  // 直接铺目录，不走 `scoop bucket add`：后者只接受合法 Git URL，会把本地路径顶回来
  // （"is not a valid Git URL"）。而 bucket 对**安装**来说就是这个目录布局本身——
  // scoop 找清单时是列 buckets/ 下的子目录再找 bucket/<名>.json，并不要求它是个 git 仓库；
  // git 只在 `scoop update` 拉取新清单时才用得上，那一段不属于本脚本要验的范围。
  const dir = join(scoopRoot, "buckets", BUCKET_NAME, "bucket");
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, "lightee.json");
  writeFileSync(manifestPath, manifestJson("0".repeat(64)), "utf8");
  log(`已铺好本地 bucket：${dir}`);
  return manifestPath;
}

function killApp() {
  spawnSync("powershell", [
    "-NoProfile",
    "-Command",
    "Get-Process -Name Lightee -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue",
  ]);
}

async function main() {
  if (!existsSync(zipPath)) {
    console.error(`找不到 zip 产物：${zipPath}\n先跑 npm run package:win`);
    process.exit(1);
  }
  if (!existsSync(scoopCmd)) {
    console.error(`找不到 scoop：${scoopCmd}`);
    process.exit(1);
  }

  const homeBefore = homeSnapshot();
  log(`~/.lightee 安装前快照：${homeBefore}`);

  const hash = await sha256(zipPath);
  log(`${ZIP_NAME} sha256 = ${hash}`);

  const server = await startServer();
  log(`本地服务器已起：127.0.0.1:${PORT}`);

  try {
    const bucketManifest = setupBucket();

    // 红：先证明哈希校验是真的在拦，而不是清单里一行装饰。
    const bad = await runScoop(["install", "lightee"], { allowFailure: true });
    // 判据必须是 scoop 明说的「哈希对不上」这句证据本身。只看退出码非 0 不够：
    // 任何一种「压根没跑起来」也是非 0，会把这条红测试变成永远通过的摆设。
    if (!/hash check failed/i.test(bad.output)) {
      throw new Error(`错误哈希没有被拦下——清单里的 hash 等于没有校验。scoop 原文：\n${bad.output}`);
    }
    if (existsSync(installedExe)) {
      throw new Error("哈希对不上却仍然把文件装了进去");
    }
    log("✅ 错误哈希被拒（校验生效）");
    await runScoop(["uninstall", "lightee"], { allowFailure: true });

    // 绿：换成正确哈希。改的就是 scoop 解析时会读到的那一份。
    writeFileSync(bucketManifest, manifestJson(hash), "utf8");
    await runScoop(["install", "lightee"]);

    if (!existsSync(installedExe)) throw new Error(`装完却找不到 ${installedExe}`);
    if (!existsSync(shimPath)) throw new Error(`装完却没有生成 shim：${shimPath}`);
    log(`✅ 已装到 ${installedExe}，shim 已生成`);

    const runStartedAt = Date.now();
    mkdirSync(workDir, { recursive: true });
    const stdioLog = join(workDir, "app-stdio.log");
    const { openSync } = await import("node:fs");
    const fd = openSync(stdioLog, "w");
    log("从 scoop 目录启动应用");
    const child = spawn(installedExe, [], { detached: true, stdio: ["ignore", fd, fd] });
    child.unref();

    const logTail = await pollUntil("AppLog 出现本轮的自更新判定记录", async () => {
      const tail = await appLogLinesSince(runStartedAt);
      if (tail.includes("self-update skipped")) return tail;
      const alive = spawnSync("powershell", [
        "-NoProfile",
        "-Command",
        "(Get-Process -Name Lightee -ErrorAction SilentlyContinue | Measure-Object).Count",
      ], { encoding: "utf8" }).stdout.trim();
      if (alive === "0") {
        const s = await readFile(stdioLog, "utf8").catch(() => "(读不到)");
        throw new Error(`应用进程已退出（非预期）。子进程 stdio 原文：\n${s}`);
      }
      return null;
    });

    if (!logTail.includes("self-update skipped: package-manager-install")) {
      throw new Error(
        `自更新判定不对。期望 package-manager-install，AppLog 本轮原文：\n${logTail}`,
      );
    }
    log("✅ 自更新已让位给包管理器（package-manager-install）");
  } finally {
    killApp();
    await sleep(1500);
    server.close();
    await runScoop(["uninstall", "lightee"], { allowFailure: true });
    for (const leftover of [join(scoopRoot, "apps", "lightee"), join(scoopRoot, "buckets", BUCKET_NAME)]) {
      if (existsSync(leftover)) await rm(leftover, { recursive: true, force: true }).catch(() => {});
    }
    const homeAfter = homeSnapshot();
    log(`~/.lightee 卸载后快照：${homeAfter}`);
    if (homeAfter !== homeBefore) {
      console.error(`❌ ~/.lightee 被安装/卸载改动了：\n  前：${homeBefore}\n  后：${homeAfter}`);
      process.exitCode = 1;
    } else {
      log("✅ ~/.lightee 未被动过");
    }
  }
}

await main();
