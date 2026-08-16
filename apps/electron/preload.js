/**
 * Secure renderer bridge. Keep this file deliberately small:
 * renderer code receives typed commands/events, never ipcRenderer or Node APIs.
 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const IPC_VERSION = 1;
const INVOKE_CHANNEL = "lightee:invoke";
const EVENT_CHANNEL = "lightee:event";
const FLUSH_CHANNEL = "lightee:flush";
const WINDOW_CHANNEL = "lightee:window";
// 关窗排空握手（RH-04）：主进程 → renderer 通知，renderer → 主进程回执。
// 刻意不走 EVENT_CHANNEL：它不是业务事件，且必须在 renderer 事件订阅之外始终可达。
const WILL_CLOSE_CHANNEL = "lightee:will-close";
const CLOSE_READY_CHANNEL = "lightee:close-ready";
const UPDATE_READY_CHANNEL = "lightee:update-ready";
const EVENT_NAMES = new Set([
  "translate.progress",
  "translate.scopeChanged",
  "review.progress",
  "bookReview.progress",
  "bookReview.changed",
  "agent.status",
  "agent.thinking",
  "agent.text",
  "workspace.changed",
  "terminology.changed",
  "chapter.saved",
  "chapter.saveFailed",
  "chapter.stateChanged",
  "terms.changed",
]);

function requestId() {
  return `renderer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// 拖入文件路径解析：sandbox 下 renderer 拿不到 File.path，由 preload 用 webUtils 解析后暂存
// 用捕获阶段(capture)监听：drop 冒泡从 side 到 window，捕获先于冒泡，确保 renderer 处理前已解析
let pendingDropPath = null;
let pendingDropName = null;
if (typeof window !== "undefined") {
  window.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    try {
      const resolved = webUtils.getPathForFile(file);
      pendingDropPath = resolved && resolved.length > 0 ? resolved : null;
    } catch {
      pendingDropPath = null;
    }
    pendingDropName = file.name ?? null;
    setTimeout(() => {
      pendingDropPath = null;
      pendingDropName = null;
    }, 4000);
  }, true);
}

const api = {
  ping: () => "pong",
  getPendingDrop: () => ({ path: pendingDropPath, name: pendingDropName }),
  invoke: (command, payload) => ipcRenderer.invoke(INVOKE_CHANNEL, {
    version: IPC_VERSION,
    requestId: requestId(),
    command,
    payload,
  }),
  onEvent: (eventName, listener) => {
    if (!EVENT_NAMES.has(eventName)) throw new Error(`Unsupported event: ${eventName}`);
    const handler = (_event, value) => {
      if (!value || value.version !== IPC_VERSION || value.type !== eventName) return;
      listener(value);
    };
    ipcRenderer.on(EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, handler);
  },
  flushPendingWrites: () => ipcRenderer.invoke(FLUSH_CHANNEL),
  // 关窗排空握手（RH-04）。必须走显式订阅 API：window 对象是分世界的，
  // 从 preload 的隔离世界 dispatchEvent 到 window 不会触达 renderer 主世界的监听器。
  onWillClose: (listener) => {
    const handler = () => {
      try {
        listener();
      } catch {
        // renderer 侧异常不得阻塞关窗——主进程有 2s 超时兜底，但不该依赖它。
      }
    };
    ipcRenderer.on(WILL_CLOSE_CHANNEL, handler);
    return () => ipcRenderer.removeListener(WILL_CLOSE_CHANNEL, handler);
  },
  // 主进程一直在发这条，而这边没有订阅口——于是新版本下载完谁都不知道，
  // 用户只有在某次退出后重开才发现版本变了。与 onWillClose 同一形态：
  // 独立通道，不混进业务事件流。
  onUpdateReady: (listener) => {
    const handler = () => {
      try {
        listener();
      } catch {
        // 提示失败不该影响任何别的事：更新本身已经下载完了。
      }
    };
    ipcRenderer.on(UPDATE_READY_CHANNEL, handler);
    return () => ipcRenderer.removeListener(UPDATE_READY_CHANNEL, handler);
  },
  closeReady: () => ipcRenderer.send(CLOSE_READY_CHANNEL),
  windowAction: (action) => {
    if (action !== "minimize" && action !== "maximize" && action !== "close") return;
    ipcRenderer.send(WINDOW_CHANNEL, action);
  },
};

contextBridge.exposeInMainWorld("lightee", api);
