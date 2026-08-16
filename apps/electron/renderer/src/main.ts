/**
 * Lightee renderer entry — clean rebuild.
 *
 * The design draft (renderer/shell/ui-shell.html) is the single visual source:
 * `sync-ui-shell.mjs` generates index.html + styles/ui-shell.css +
 * public/ui-shell-runtime.js from it. This entry only:
 *   1. loads the design runtime (render-only mode),
 *   2. mounts the stage and lets the design render its views,
 *   3. keeps the Electron security boundary (contextIsolation + sandbox).
 *
 * Real IPC wiring (CodeMirror, autosave, terminology, translation, review,
 * export) is added incrementally on top of this clean base.
 */
import "./../styles/ui-shell.css";
import "./../styles/renderer.css";
import "./../styles/agent-console.css";
import { IpcWorkspaceAdapter } from "./workspace/workspace-store.js";
import { mountWorkspaceBridge, type WorkspaceBridge } from "./workspace/workspace-bridge.js";

interface RenderOnlyRuntimeWindow extends Window {
  __lighteeRenderOnlyRuntime?: boolean;
  renderDash?: () => string;
  renderMain?: () => string;
  __lighteeWorkspaceBridge?: WorkspaceBridge;
}

function loadDesignRuntime(renderOnly: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const runtimeWindow = window as RenderOnlyRuntimeWindow;
    runtimeWindow.__lighteeRenderOnlyRuntime = renderOnly;
    document.documentElement.dataset.runtimeMode = renderOnly ? "render-only" : "legacy";
    const script = document.createElement("script");
    script.src = new URL("./ui-shell-runtime.js", document.baseURI).toString();
    script.onload = () => {
      if (typeof runtimeWindow.renderDash !== "function" || typeof runtimeWindow.renderMain !== "function") {
        reject(new Error("Design runtime did not expose render functions"));
        return;
      }
      resolve();
    };
    script.onerror = () => reject(new Error("Could not load design runtime"));
    document.head.append(script);
  });
}

function bindWindowChrome(): void {
  const actions: Array<[string, "minimize" | "maximize" | "close"]> = [
    ["[data-window-minimize]", "minimize"],
    ["[data-window-maximize]", "maximize"],
    ["[data-window-close]", "close"],
  ];
  actions.forEach(([selector, action]) => {
    document.querySelectorAll<HTMLElement>(selector).forEach((button) => {
      button.addEventListener("click", () => window.lightee?.windowAction(action));
    });
  });
}

function bindDashboardActions(bridge: WorkspaceBridge): void {
  const bindButton = (selector: string, action: () => void): void => {
    document.querySelectorAll<HTMLElement>(selector).forEach((button) => {
      // 覆盖设计稿占位 onclick（pushEvent），接管为真实动作
      button.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        action();
      };
    });
  };
  // Design draft dashboard provides two workspace actions with no real handlers.
  bindButton("[data-wc-actions] .wc-btn:nth-child(1)", () => void bridge.openWorkspacePicker());
  bindButton("[data-wc-actions] .wc-btn:nth-child(2)", () => void bridge.createWorkspaceFlow());
  // 侧栏书栏「＋」= 打开工作区选择器（覆盖设计稿占位）
  bindButton(".book-add", () => void bridge.openWorkspacePicker());
  // The workspace card may be re-rendered by the runtime; re-bind after each render.
  const observer = new MutationObserver(() => {
    bindButton("[data-wc-actions] .wc-btn:nth-child(1)", () => void bridge.openWorkspacePicker());
    bindButton("[data-wc-actions] .wc-btn:nth-child(2)", () => void bridge.createWorkspaceFlow());
    bindButton(".book-add", () => void bridge.openWorkspacePicker());
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

async function boot(): Promise<void> {
  try {
    (window as Window & { __lighteeLegacyVariantRoute?: boolean }).__lighteeLegacyVariantRoute = false;
    await loadDesignRuntime(true);
    const runtimeWindow = window as RenderOnlyRuntimeWindow;
    if (typeof (runtimeWindow as unknown as { show?: () => void }).show === "function") {
      (runtimeWindow as unknown as { show: () => void }).show();
    } else {
      const stage = document.getElementById("stage");
      if (stage && runtimeWindow.renderDash) stage.innerHTML = runtimeWindow.renderDash();
    }
    bindWindowChrome();
    if (window.lightee) {
      const bridge = await mountWorkspaceBridge(new IpcWorkspaceAdapter());
      (window as RenderOnlyRuntimeWindow).__lighteeWorkspaceBridge = bridge;
      bindDashboardActions(bridge);
      // 主页顺序：启动中心第一位（真实数据），工作台第二位——启动停留在启动中心，
      // 由用户点击「上次编辑/工作区/快速列表」才进入工作台
      await bridge.refreshDashboard();
      // 设计 runtime 的首帧在 bridge 挂载前完成；下一帧再刷新，避免其占位卡片覆盖真实书架。
      // 这一次刷新必须**等到**才算就绪：它自己也在发 IPC，而 rendererReady 是外部
      // （发布门禁、自动化）判断「可以开始操作了」的唯一信号。在它还在飞的时候就说就绪，
      // 等于邀请别人和启动收尾抢时序——门禁上的表现是刚建好的工作区随后报 not open。
      await new Promise<void>((settled) => { window.setTimeout(() => void bridge.refreshDashboard().finally(() => settled()), 0); });
    }
    document.documentElement.dataset.rendererReady = "true";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    document.documentElement.dataset.rendererReady = "false";
    const stage = document.getElementById("stage");
    if (stage) stage.innerHTML = `<pre style="color:#f87171;padding:20px;white-space:pre-wrap">Renderer boot failed: ${message}</pre>`;
    console.error("[lightee renderer] boot failed", error);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void boot(), { once: true });
} else {
  void boot();
}
