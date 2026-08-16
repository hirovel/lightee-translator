/**
 * 编辑器挂载不变式（RH-12 / design/renderer-dom-ownership.md §3）。
 *
 * **不变式**：`bi` tab 激活 ∧ 存在当前章节 ⟹ 恰好满足以下之一：
 * 1. 编辑器会话存活，且其视图挂载在 `#bpanel` 内的编辑器宿主中；
 * 2. 显式空原文引导；
 * 3. 显式加载中 / 错误界面（含「重新加载」入口）。
 *
 * **空白 `#bpanel` 不是合法状态**——DEF-01（空白编辑器）就是这个状态被当成合法留在了页面上。
 *
 * 这是**结构护栏，不是修复手段**：门禁与单测仍以「它一次都不触发」为准。它触发就说明
 * 有一条控制流停在了销毁处而没有走回渲染入口——那条路径才是要修的缺陷。
 *
 * 模块内切成两半，是为了让有分支的那一半可测：`readPanelSurface` 只做三次 `querySelector`
 * （零分支，且 renderer 测试环境是 node、没有 DOM）；`checkEditorMount` 承担全部判定逻辑，
 * 是不碰 DOM 的纯函数，因此能直接单测——`workspace-bridge.ts` 是一整个闭包，
 * 没有办法从外部构造它的内部状态。
 */

/** `#bpanel` 当前呈现的界面种类（由 DOM 读取层归类后交给判定层） */
export interface PanelSurface {
  /** 是否存在编辑器宿主（译文编辑或原文编辑，两者都带 `.continuous-editor`） */
  hasEditorHost: boolean;
  /** 是否存在显式空态/加载中/错误界面——无会话时这些是合法终态 */
  hasExplicitSurface: boolean;
}

/** 无会话时可以合法留在 `#bpanel` 的显式界面 */
const EXPLICIT_SURFACE_SELECTOR = ".ws-empty-guide, .ws-editor-loading, .ws-editor-error";

/**
 * 编辑器宿主。译文编辑与原文编辑各有一个 id，但都带 `.continuous-editor`——
 * 用 class 判定，避免将来加第三种编辑视图时这里悄悄漏判。
 */
const EDITOR_HOST_SELECTOR = ".continuous-editor";

/** DOM 读取层：零分支，只把 `#bpanel` 的现状翻译成 `PanelSurface`。面板未挂载时返回 null */
export function readPanelSurface(panel: ParentNode | null): PanelSurface | null {
  if (!panel) return null;
  return {
    hasEditorHost: Boolean(panel.querySelector(EDITOR_HOST_SELECTOR)),
    hasExplicitSurface: Boolean(panel.querySelector(EXPLICIT_SURFACE_SELECTOR)),
  };
}

export interface EditorMountInput {
  /** 当前激活的工作流 tab */
  tab: string;
  /** 是否存在「当前章节」 */
  hasChapter: boolean;
  /** `editorSession` 或 `sourceEditorSession` 是否存活 */
  hasLiveSession: boolean;
  /** `readPanelSurface()` 的结果；工作台外壳尚未渲染时为 null */
  surface: PanelSurface | null;
}

export type EditorMountVerdict = { ok: true } | { ok: false; reason: string };

const OK: EditorMountVerdict = { ok: true };

export function checkEditorMount({ tab, hasChapter, hasLiveSession, surface }: EditorMountInput): EditorMountVerdict {
  // 不变式只约束 bi + 有章节 + 面板已存在这一种情形；其余情形不适用（不是「合法」，是「无关」）
  if (tab !== "bi" || !hasChapter || !surface) return OK;

  if (hasLiveSession) {
    // 会话存活但宿主不在面板里 = 会话挂在已脱离文档的节点上：用户看到的是别的东西，
    // 而输入会写进一个不可见的编辑器。比空白更危险，因此同样判违反。
    return surface.hasEditorHost ? OK : { ok: false, reason: "会话存活但编辑器宿主不在 #bpanel 内（视图已被覆盖）" };
  }

  if (surface.hasExplicitSurface) return OK;

  return {
    ok: false,
    reason: surface.hasEditorHost
      ? "编辑器会话已销毁，#bpanel 里只剩空壳宿主"
      : "编辑器会话已销毁，且 #bpanel 没有任何显式空态/加载中/错误界面",
  };
}
