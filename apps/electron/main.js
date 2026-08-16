/**
 * Lightee 桌面端 —— 主进程（main process）。
 *
 * 架构（wayfinder map Notes）:
 *   - 内核同进程直连: 这里直接 import engine（全部 async，不阻塞 UI 线程）
 *   - renderer 零 Node: contextIsolation + sandbox（marktext 实践）
 *   - IPC: renderer → main 的 invoke 命令 + 事件推送
 *
 * Ticket 01: 先跑通窗口骨架（加载 renderer），IPC 契约在 Ticket 02。
 */
// ↓ 这四个 import 的**顺序是语义的一部分**，别调，也别把它们换成模块体里的调用。
// ESM 会把一个模块的全部 import 先求值完，才轮到模块体的第一条语句——所以「先后」
// 只能靠 import 的排列表达：
//
//   1. user-data-root       定下 userData 到底在哪（单实例锁就存在 userData 里，
//                           设晚了会出现新旧两份应用各拿各的锁、互不排斥）
//   2. single-instance      抢锁；抢不到的进程在这里就退出，于是只有一个进程会迁移
//   3. storage-migration    把旧数据搬进新根
//   4. main-ipc             构造 AppLog、读工作区注册表——此时数据必须已经就位
import { migrationLog } from "./user-data-root.js";
import "./single-instance.js";
import "./storage-migration-boot.js";
import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appLog, ipcService } from "./dist-main/main-ipc.js";
import { EVENT_CHANNEL, FLUSH_CHANNEL, INVOKE_CHANNEL } from "./dist-main/shared/ipc-contract.js";
import { evaluateSelfUpdate } from "./dist-main/shared/self-update-policy.js";
import updater from "electron-updater";
const { autoUpdater } = updater;

// ===== 网络配置（参考 pi http-dispatcher）：解决「fetch failed」 =====
// 1. DNS 解析优先 IPv4（Node 默认 250ms 的 family 选择常让纯 IPv4 高延迟路由连不上 → fetch failed）
// 2. undici EnvHttpProxyAgent：支持 HTTP_PROXY/HTTPS_PROXY 代理 + autoSelectFamilyAttemptTimeout 2s + 长超时
import dns from "node:dns";
async function configureHttpNetwork() {
  try { dns.setDefaultResultOrder("ipv4first"); } catch { /* 旧 Node 忽略 */ }
  try {
    const undici = await import("undici");
    if (undici?.setGlobalDispatcher && undici?.EnvHttpProxyAgent) {
      undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent({
        allowH2: false,
        connect: { autoSelectFamilyAttemptTimeout: 2000 },
        bodyTimeout: 300_000,
        headersTimeout: 300_000,
      }));
    }
  } catch {
    // undici 不可用时依赖 Node 内置 fetch（ipv4first 已解决主要问题）
  }
}
void configureHttpNetwork();

// 迁移发生在 AppLog 存在之前（它自己就住在数据根里），所以那几行是攒着的，这里补记。
// 只有路径与文件数，没有任何配置值。
for (const line of migrationLog) void appLog.write("info", line);

const __dirname = dirname(fileURLToPath(import.meta.url));
let quitting = false;

// 关窗排空握手通道（与 preload.js 一致；刻意不放进业务事件通道）
const WILL_CLOSE_CHANNEL = "lightee:will-close";
const CLOSE_READY_CHANNEL = "lightee:close-ready";
/** 新版已下载、退出时安装（与 preload.js 一致） */
const UPDATE_READY_CHANNEL = "lightee:update-ready";

ipcMain.handle(INVOKE_CHANNEL, (_event, envelope) => ipcService.invoke(envelope));

ipcMain.handle(FLUSH_CHANNEL, () => ipcService.flushPendingWrites());

ipcMain.on("lightee:window", (event, action) => {
  if (action !== "minimize" && action !== "maximize" && action !== "close") return;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  if (action === "minimize") win.minimize();
  else if (action === "maximize") win.isMaximized() ? win.unmaximize() : win.maximize();
  else win.close();
});

ipcService.subscribe((event) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    try {
      window.webContents.send(EVENT_CHANNEL, event);
    } catch {
      // A renderer may disappear between the destroyed check and send.
    }
  }
});

/**
 * 关窗第一阶段（RH-04）：通知 renderer 排空编辑会话并等待回执。
 *
 * renderer 崩溃/未注册监听/排空超时都不得让窗口挂住——2 秒后无条件进入第二阶段。
 * 回执只表示「renderer 已把能落的都发出去了」，不表示写入已完成；写入完成由第二阶段的
 * flushPendingWrites 负责。
 */
function waitForRendererClose(win, timeoutMs = 2_000) {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener(CLOSE_READY_CHANNEL, onReady);
      clearTimeout(timer);
      resolve();
    };
    const onReady = (event) => {
      if (BrowserWindow.fromWebContents(event.sender) === win) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    ipcMain.on(CLOSE_READY_CHANNEL, onReady);
    try {
      win.webContents.send(WILL_CLOSE_CHANNEL);
    } catch {
      finish();
    }
  });
}

function configureAutoUpdates() {
  const decision = evaluateSelfUpdate({ isPackaged: app.isPackaged, env: process.env, execPath: process.execPath });
  if (!decision.update) {
    if (decision.reason !== "not-packaged") void appLog.write("info", `self-update skipped: ${decision.reason}`);
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // autoUpdater 是个 EventEmitter：下载/校验失败时内部调 dispatchError() → emit("error", ...)。
  // Node 对零监听器的 "error" 事件默认同步抛出、让进程崩溃——这条监听器不是锦上添花，
  // 少了它，一次网络抖动或下载损坏就会把整个应用带崩，而不是「这次没查到更新」那样
  // 悄悄过去。RL-08 更新闭环演练能发现这个，是因为它真的让下载走到了失败分支；
  // 生产环境同样会走到，只是概率低、日志缺失时更难查。
  autoUpdater.on("error", (err) => {
    void appLog.write("error", `self-update failed: ${err?.message || err}`);
  });
  autoUpdater.on("update-downloaded", () => {
    void appLog.write("info", "update downloaded, will install on quit");
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(UPDATE_READY_CHANNEL);
    }
  });
  void autoUpdater.checkForUpdates().catch(() => {
    // Update availability must never prevent the application from starting.
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    backgroundColor: "#05080c",
    title: "✦ lightee",
    // 打包后的 exe 图标由 electron-builder 从 build/icon.png 生成，但**窗口自己**的图标
    // 是另一回事：不显式给，开发运行（electron .）时任务栏和 Alt+Tab 里挂的是
    // Electron 默认的原子图标。图标做好了却一直没见着，就是漏在这里。
    icon: join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const devServerUrl = process.env.LIGHTEE_DEV_SERVER_URL;
  if (devServerUrl) {
    win.loadURL(devServerUrl);
  } else {
    win.loadFile(join(__dirname, "dist", "index.html"));
  }
  let closeStarted = false;
  win.on("close", (event) => {
    if (quitting || closeStarted) return;
    event.preventDefault();
    closeStarted = true;
    // 关窗排空握手（RH-04 / DEF-04）：先让 renderer 把防抖中的编辑落盘，再排空主进程写队列。
    // 只 drain 主进程队列是不够的——1000ms autosave 防抖里的草稿还没到过主进程。
    // markClosing 必须在握手**之后**：它会让后续 invoke 一律返回 shutdown，
    // 提前调用等于把 renderer 的最后一次 saveDraft 直接拒掉。
    void waitForRendererClose(win)
      .then(() => {
        ipcService.markClosing();
        return Promise.race([
          ipcService.flushPendingWrites(),
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
      })
      .finally(() => win.destroy());
  });
  if (process.env.LIGHTEE_OPEN_DEVTOOLS === "1") {
    win.webContents.openDevTools({ mode: "detach" });
  }
}

let quitDrained = false;
app.on("before-quit", (event) => {
  // 退出路径同样要走排空握手：否则「关最后一个窗口 / Cmd+Q / 更新重启」会绕过 renderer 排空。
  if (quitDrained) {
    quitting = true;
    ipcService.markClosing();
    return;
  }
  event.preventDefault();
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  void Promise.all(windows.map((win) => waitForRendererClose(win)))
    .then(() => {
      ipcService.markClosing();
      return Promise.race([
        ipcService.flushPendingWrites(),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    })
    .finally(() => {
      quitDrained = true;
      quitting = true;
      void appLog.write("info", "shutdown: write queue drained");
      void appLog.close();
      app.quit();
    });
});

/**
 * 最外层崩溃兜底。
 *
 * 全库都在贯彻「失败必须说出来」，唯独最外层是沉默的：逃逸的 rejection 或异常此前
 * 不留任何痕迹，用户只看到应用卡住，事后也无从追查。
 *
 * 三条原则：
 * - **只记录，不退出**。逃逸异常多半来自某一次网络/解析，杀掉进程会连带丢掉正在
 *   翻译的章节；Electron 的默认行为（继续跑）在这里是对的。真正致命的错误会自己崩。
 * - 日志走 appLog，它带脱敏与截断（密钥、prompt、正文都不会落盘）。
 * - 渲染进程消失单独记：那是白屏的直接成因，与主进程异常不是一回事。
 */
function installCrashLogging() {
  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : String(reason);
    void appLog.write("error", `unhandledRejection: ${detail}`);
  });
  process.on("uncaughtException", (error) => {
    void appLog.write("error", `uncaughtException: ${error.message}\n${error.stack ?? ""}`);
  });
  app.on("render-process-gone", (_event, _contents, details) => {
    void appLog.write("error", `render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`);
  });
  app.on("child-process-gone", (_event, details) => {
    void appLog.write("error", `child-process-gone: type=${details.type} reason=${details.reason}`);
  });
}

/**
 * 无头后端入口（LIGHTEE_HEADLESS_SCRIPT）。
 *
 * 为什么必须在主进程里：API 密钥是 DPAPI 封存的，只有主进程能在进程内解开。
 * 纯 node 脚本拿不到密钥，而把它解到脚本或环境变量里等于把封存作废。
 *
 * 为什么不开窗：后端跑批不该被渲染层的启动时序影响。真实教训是同一天里
 * 发布门禁两次失败都出在渲染层就绪这一层，与后端行为无关——测后端就只测后端。
 */
async function runHeadlessScript(scriptPath) {
  const { pathToFileURL } = await import("node:url");
  let code = 0;
  try {
    const mod = await import(pathToFileURL(scriptPath).href);
    const run = mod.default ?? mod.run;
    if (typeof run !== "function") throw new Error(`${scriptPath} 没有导出可调用的 default/run`);
    code = (await run({ ipcService, appLog, app })) ?? 0;
  } catch (error) {
    console.error(error);
    code = 1;
  }
  // 排空在途写入再退，否则最后几次调用的账本行会丢——账丢了这次跑批就白跑。
  try { await ipcService.flushPendingWrites(); } catch { /* 已经在退出路径上 */ }
  app.exit(code);
}

app.whenReady().then(() => {
  // Windows 上通知弹窗的标题与图标取自 AppUserModelID，不是取自窗口。
  // 不设它，跑批完成那条通知会以「Electron」的身份和默认图标弹出来。
  // 必须与 electron-builder 的 appId 一致，否则安装版和运行中的进程在任务栏被当成两个应用。
  if (process.platform === "win32") app.setAppUserModelId("com.hirovel.lightee");
  void appLog.write("info", `startup version=${app.getVersion()} packaged=${app.isPackaged} platform=${process.platform}`);
  installCrashLogging();
  const headless = process.env.LIGHTEE_HEADLESS_SCRIPT;
  if (headless) {
    void runHeadlessScript(headless);
    return;
  }
  createWindow();
  configureAutoUpdates();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
