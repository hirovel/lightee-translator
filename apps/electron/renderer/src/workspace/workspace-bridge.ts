/**
 * Workspace bridge — clean rebuild, file-system stage.
 *
 * This module wires the design draft's dashboard and workbench shell to the
 * real workspace filesystem through typed IPC. It does not touch the design
 * runtime's simulation logic; it only reads `workspace.list` / `workspace.open`
 * / `workspace.create` / `dialog.pickDirectory` and renders real volume/chapter
 * trees into the design's DOM slots.
 *
 * (Import flow UI is still under design review; the side import button and
 * target position selector are design-draft only and not wired here yet.)
 */
import { IpcWorkspaceAdapter } from "./workspace-store.js";
import { editorFootBar, FOOT_COUNT_SELECTOR } from "./editor-foot-bar.js";
import { escapeHtml } from "./html.js";
import { detectSyncFolder } from "./sync-folder.js";
import type { WorkspaceRecord } from "./workspace-store.js";
import { paragraphEditor } from "../editor/paragraph-editor.js";
import { ParagraphDocument } from "../editor/paragraph-document.js";
import { AutosaveController, SourceCorrectionController, type AutosaveState } from "../editor/autosave.js";
import { WorkbenchContextCoordinator, type EffectToken, type WorkbenchTab } from "./workbench-context-coordinator.js";
import { acceptsAgentEvent, acceptsChapterEvent, acceptsWorkspaceEvent } from "./workbench-event-scope.js";
import { hasAuthorVisibleSource } from "./source-presence.js";
import { acceptableChapters, composeExport, describeComposition, describeExportResult, exportBlockReason, type ExportChapterState, type ExportComposition } from "./export-composition.js";
import { createReentrantRefresh } from "./reentrant-refresh.js";
import { checkEditorMount, readPanelSurface } from "./editor-invariant.js";
import { describeModelIndicator, isLocalBaseUrl, type IndicatorOption, type IndicatorProvider, type ProbeResult } from "./model-indicator.js";
import { describeThinking, emptyThinking, reduceThinking, type ThinkingState } from "./thinking-view.js";
import { currentActivity, emptyTranscript, reduceTranscript, type TranscriptEvent, type TranscriptState } from "./run-transcript.js";
import { liveWritingPosition, type LiveProgress } from "./live-progress.js";
import { defaultSelection, isDoneState, isInFlightState, stuckChapterIds, summarizeSelection, type ScopeChapterOption } from "./run-scope-plan.js";
import { busyScopePrefix, reduceScopeEvent, stopButtonView, type ScopeChangedPayload, type ScopeRunView } from "./scope-progress.js";
import { describeUsage, type UsageGroupInput, type UsageReportInput } from "./usage-view.js";
import { resolveSelectedProvider } from "./ai-panel-state.js";
import { termBadgeView, termListEmptyText } from "./terminology-view.js";
import { CACHE_RATE_NOTE, CACHE_RATE_TITLE, CALL_CACHE_TITLE, formatCallCache, formatHitRate } from "./cache-usage.js";
import { traceSearchMatch, traceStats, traceTimeline, type TraceLayoutMode } from "./trace-view.js";
import { currentVolumeId } from "./volume-highlight.js";
import type { LlmUsageSnapshot } from "../../../shared/ipc-contract";
import { identifyThinkingPreset, supportedThinkingLevels, THINKING_PRESET_LABELS, THINKING_PRESET_MAPS, THINKING_PRESET_RESULT_ONLY } from "../../../shared/thinking-levels";

export interface WorkspaceBridge {
  adapter: IpcWorkspaceAdapter;
  refreshDashboard(): Promise<void>;
  openWorkspacePicker(): Promise<void>;
  createWorkspaceFlow(): Promise<void>;
  enterWorkbench(workspaceId: string): Promise<void>;
  backToDashboard(): Promise<void>;
  getCurrentWorkspace(): WorkspaceRecord | null;
  getVolumes(): Array<{ id: string; name: string; chapters: Array<{ chapterId: string; title: string }> }>;
  createChapter(volumeId: string, title?: string): Promise<void>;
  deleteChapter(volumeId: string, chapterId: string, button: HTMLElement): Promise<void>;
  deleteVolume(volumeId: string, button: HTMLElement): Promise<void>;
  moveChapter(chapterId: string, targetVolumeId: string, afterChapterId?: string, atStart?: boolean): Promise<void>;
  updateEditorSettings(patch: Partial<{ fontSize: number; sourceColor: "dim" | "soft" | "faint"; paragraphGap: "tight" | "natural" | "loose"; termHighlight: "highlight" | "underline" | "none"; sourceLink: boolean; focusCenter: boolean; cursorAnimate: boolean; cursorBlink: boolean; cursorShape: "block" | "beam" | "underline"; sourceEditable: boolean }>): Promise<boolean>;
  /** 底栏「本章检查」/ Ctrl+R：切到审校 tab 并跑一遍确定性扫描 */
  runChapterCheck(): void;
}

interface BridgeWindow extends Window {
  __lighteeWorkspaceBridge?: WorkspaceBridge;
  __lighteeRenderOnlyRuntime?: boolean;
  __bridgeUndoBound?: boolean;
  /** 设计稿运行时里的底栏动作（底栏快捷键复用它们，避免两套实现各走各的） */
  toggleExport?: () => void;
  openSettings?: () => void;
  renderDash?: () => string;
  renderMain?: () => string;
  pushEvent?: (message: string, tone?: string) => void;
  openChapter?: (chapterId: string) => void;
  moveCursor?: (snap?: boolean) => void;
  closeAllCs?: () => void;
  bindSideDrop?: () => void;
  bindTabs?: () => void;
  renderPanel?: () => void;
  importPreview?: (mode?: string) => void;
  showToast?: (message: string, opts?: { undo?: () => void; duration?: number }) => void;
}

function chapterStateLabel(state: WorkspaceRecord["volumes"][number]["chapters"][number]["state"]): string {
  switch (state) {
    case "approved": return "已译";
    case "translated": return "待审";
    case "translating": return "翻译中";
    case "reviewing": return "审校中";
    case "revising": return "修订中";
    case "stuck": return "卡住";
    // imported 与 ready 对作者是同一件事（都还没翻），状态机里 imported 也只能走向 ready。
    // 从前一个叫「未开始」一个叫「待译」，两个词摆在同一列文件树里，谁都说不出差别在哪。
    case "imported":
    case "ready":
    default: return "未译";
  }
}

function chapterStateColor(state: WorkspaceRecord["volumes"][number]["chapters"][number]["state"]): string {
  switch (state) {
    case "approved": return "var(--green)";
    case "translated": return "var(--blue)";
    case "translating": return "var(--yellow)";
    case "reviewing": return "var(--yellow)";
    case "revising": return "var(--accent2)";
    case "stuck": return "var(--red)";
    case "imported": return "var(--dimmer)";
    case "ready":
    default: return "var(--dim)";
  }
}

function chapterStateIcon(state: WorkspaceRecord["volumes"][number]["chapters"][number]["state"]): string {
  switch (state) {
    case "approved": return "✔";
    case "translated": return "◈";
    case "translating": return "◉";
    case "reviewing": return "◉";
    case "revising": return "↻";
    case "stuck": return "⚠";
    case "imported": return "○";
    case "ready":
    default: return "◇";
  }
}

export async function mountWorkspaceBridge(adapter: IpcWorkspaceAdapter): Promise<WorkspaceBridge> {
  const runtimeWindow = window as BridgeWindow;
  let activeWorkspace: WorkspaceRecord | null = null;
  // Agent 控制台：各 agent 最近状态（agent.status 事件驱动）
  const agentStates: Record<string, { status: string; message: string; ts: number }> = {};
  type ActiveChapterContent = { workspaceId: string; chapterId: string; revision: number; source: Array<{ id: string; text: string }>; translation: Array<{ id: string; text: string }> };
  type EditorSession = {
    workspaceId: string;
    chapterId: string;
    token: EffectToken;
    editor: ReturnType<typeof paragraphEditor>;
    autosave: AutosaveController;
    latestParagraphs: Array<{ id: string; source: string; translation: string }>;
  };
  type SourceEditorSession = {
    workspaceId: string;
    chapterId: string;
    token: EffectToken;
    controller: SourceCorrectionController;
  };
  const workbenchContext = new WorkbenchContextCoordinator();
  let chapterEditor: ReturnType<typeof paragraphEditor> | null = null;
  let editorSession: EditorSession | null = null;
  let sourceEditorSession: SourceEditorSession | null = null;
  let activeChapterContent: ActiveChapterContent | null = null;
  let needsChapterReload = false;
  let chapterRenderSequence = 0;
  let sourceVisible = true;
  let editorVisual: { fontSize: number; sourceColor: "dim" | "soft" | "faint"; paragraphGap: "tight" | "natural" | "loose"; termHighlight: "highlight" | "underline" | "none"; sourceLink: boolean; focusCenter: boolean; cursorAnimate: boolean; cursorBlink: boolean; cursorShape: "block" | "beam" | "underline"; sourceEditable: boolean } | null = null;

  // ===== 真实章节编辑器：Obsidian 式全宽连续输入（作者校对） =====
  // 整章一个连续 CodeMirror；每段译文上方 widget 装饰日文原文（同字号暗色）；软段落（Enter 软换行不拆段）；术语高亮；原文显隐小开关
  // 当前激活的工作流 tab（面板渲染竞态防护用）
  function activeBtab(): WorkbenchTab {
    const tab = document.querySelector("[data-btab].on")?.getAttribute("data-btab");
    return tab === "terms" || tab === "review" || tab === "agent" ? tab : "bi";
  }


  function showSaveState(state: AutosaveState): void {
    const hint = document.getElementById("save-hint");
    if (!hint) return;
    const labels: Record<AutosaveState["phase"], string> = {
      idle: "无改动",
      modified: "编辑中…",
      saving: "保存中…",
      saved: "已保存",
      failed: "保存失败 · 请重试",
      conflict: "版本冲突 · 请重新加载",
    };
    // 底栏这一格从前恒为绿色，于是「保存失败」和「版本冲突」也是绿的——颜色在说
    // 与文字相反的话，而扫一眼底栏的人只看得见颜色。
    const tones: Record<AutosaveState["phase"], string> = {
      idle: "idle", modified: "busy", saving: "busy", saved: "ok", failed: "error", conflict: "error",
    };
    hint.textContent = labels[state.phase];
    hint.dataset.tone = tones[state.phase];
  }

  async function flushEditorSession(): Promise<boolean> {
    const session = editorSession;
    if (session) {
      await session.autosave.flush();
      const state = session.autosave.getState();
      if (state.phase === "failed" || state.phase === "conflict") {
        showSaveState(state);
        runtimeWindow.pushEvent?.(state.phase === "conflict" ? "译文版本冲突，已留在当前章节" : "译文保存失败，已留在当前章节", "err");
        runtimeWindow.showToast?.(state.phase === "conflict" ? "版本冲突，请重新加载后再切换" : "保存失败，请重试后再切换", { duration: 3600 });
        return false;
      }
    }
    const sourceSession = sourceEditorSession;
    if (!sourceSession) return true;
    await sourceSession.controller.flush();
    const sourceState = sourceSession.controller.getState();
    if (sourceState.phase !== "failed" && sourceState.phase !== "conflict") return true;
    const hint = document.getElementById("src-edit-hint");
    if (hint) { hint.textContent = sourceState.phase === "conflict" ? "原文版本冲突" : "原文保存失败"; hint.dataset.tone = "error"; }
    runtimeWindow.pushEvent?.(sourceState.phase === "conflict" ? "原文版本冲突，已留在当前章节" : "原文保存失败，已留在当前章节", "err");
    return false;
  }

  async function leaveEditorSession(): Promise<boolean> {
    const session = editorSession;
    const sourceSession = sourceEditorSession;
    if (!session && !sourceSession) return true;
    if (!await flushEditorSession()) return false;
    if (session) {
      session.autosave.dispose();
      session.editor.destroy();
      if (editorSession === session) editorSession = null;
      if (chapterEditor === session.editor) chapterEditor = null;
    }
    if (sourceSession) {
      sourceSession.controller.dispose();
      if (sourceEditorSession === sourceSession) sourceEditorSession = null;
    }
    return true;
  }

  function transitionContext(workspaceId: string | null, chapterId: string | null, tab: WorkbenchTab): void {
    workbenchContext.transition({ workspaceId, chapterId, tab });
    chapterRenderSequence += 1;
  }

  function restoreTabSelection(tab: WorkbenchTab): void {
    document.querySelectorAll<HTMLElement>("[data-btab]").forEach((node) => {
      const selected = node.dataset.btab === tab;
      node.classList.toggle("on", selected);
      node.setAttribute("aria-selected", String(selected));
    });
  }

  let tabTransitionInFlight = false;
  async function selectWorkbenchTab(tab: WorkbenchTab): Promise<void> {
    if (!activeWorkspace || !tab || tabTransitionInFlight) return;
    const current = workbenchContext.current();
    if (current.tab === tab) {
      restoreTabSelection(tab);
      runtimeWindow.renderPanel?.();
      return;
    }
    tabTransitionInFlight = true;
    const previousTab = current.tab ?? "bi";
    try {
      if (previousTab === "bi" && !await leaveEditorSession()) {
        restoreTabSelection(previousTab);
        return;
      }
      const chapterId = activeChapterContent?.chapterId ?? current.chapterId;
      transitionContext(activeWorkspace.id, chapterId, tab);
      restoreTabSelection(tab);
      runtimeWindow.renderPanel?.();
    } finally {
      tabTransitionInFlight = false;
    }
  }

  function bindProtectedTabs(): void {
    document.querySelectorAll<HTMLElement>("[data-btab]").forEach((tab) => {
      tab.onclick = (event) => {
        event.preventDefault();
        void selectWorkbenchTab((tab.dataset.btab as WorkbenchTab) ?? "bi");
      };
    });
  }

  async function openChapterSafely(workspaceId: string, chapterId: string): Promise<boolean> {
    const current = workbenchContext.current();
    const sameChapter = current.workspaceId === workspaceId && current.chapterId === chapterId;
    const hadSession = Boolean(editorSession || sourceEditorSession);
    if (hadSession && !await leaveEditorSession()) {
      bailChapterRender(chapterId, "上一章未能保存，切换被拦下");
      return false;
    }
    // 挂载不变式（renderer-dom-ownership.md §3）：判据必须基于「此刻是否有存活会话」，
    // 而不是「本函数内是否销毁过会话」。调用方（章节点击、stateChanged 强刷）会在进入前
    // 先行销毁会话，此时 hadSession 为假——缺少 !editorSession 会让重渲染被整体跳过，
    // #chapter-editor-host 空壳永久留在页面上（DEF-01）。
    if (hadSession || !editorSession || !sameChapter || !document.getElementById("chapter-editor-host") || needsChapterReload) {
      await renderChapterContent(workspaceId, chapterId);
    }
    // 会话记录在**这里**写，因为所有打开章节的路径都汇聚到这个函数。
    // 从前只写在侧栏点击处理器里：建工作区自动开首章、进工作台恢复上一章、
    // 「从这句继续」——这些路径一次都不记，只有一章的书甚至永远不会被记录，
    // 于是仪表盘的「上次编辑」抓着别的工作区的陈年会话不放。
    void adapter.setSession({ workspaceId, chapterId, savedAt: Date.now() });
    return true;
  }

  /**
   * 编辑器挂载不变式的结构护栏（RH-12 / design/renderer-dom-ownership.md §3）。
   *
   * **它触发就是缺陷**——说明某条控制流在销毁会话后停住了，没有走回渲染入口。
   * 因此这里除了恢复，还必须留下一条带触发路径标识的告警：护栏静默恢复等于把
   * DEF-01 从「看得见的空白」变成「看不见的重复渲染」，那更难查。
   *
   * 门禁与单测均以「零触发」为准（`window.__lighteeInvariantTrips` 是门禁的观测点，
   * 不是运行时依赖——renderer 不读它）。
   */
  function ensureEditorInvariant(origin: string): void {
    if (!activeWorkspace || !activeChapterContent) return;
    // 渲染在飞 = 过渡态，不检。见 chapterRendersInFlight 的注释。
    if (chapterRendersInFlight > 0) return;
    // 结构防御（与上面的挂载清理互为双保险）：章节快照必须属于当前工作区。
    // 残影配新 id 去「恢复」只会加载出 Unknown chapter，比不恢复更糟。
    if (activeChapterContent.workspaceId !== activeWorkspace.id) return;
    const verdict = checkEditorMount({
      tab: activeBtab() ?? "bi",
      hasChapter: true,
      hasLiveSession: Boolean(editorSession ?? sourceEditorSession),
      surface: readPanelSurface(document.getElementById("bpanel")),
    });
    if (verdict.ok) return;
    const bridgeWindow = window as BridgeWindow & { __lighteeInvariantTrips?: string[] };
    (bridgeWindow.__lighteeInvariantTrips ??= []).push(`${origin}: ${verdict.reason}`);
    runtimeWindow.pushEvent?.(`编辑器挂载护栏触发（${origin}）：${verdict.reason}`, "err");
    const workspaceId = activeWorkspace.id;
    const chapterId = activeChapterContent.chapterId;
    void renderChapterContent(workspaceId, chapterId).then(() => {
      // RH-13：自动恢复也可能失败（磁盘错误、章节被并发删除…）。此时必须留一个
      // **人能点的出口**，而不是让用户对着空白面板猜。复用既有的 .ws-editor-error
      // 样式与 chapter-reload 交互，不引入新的视觉语言。
      const recovered = checkEditorMount({
        tab: activeBtab() ?? "bi",
        hasChapter: true,
        hasLiveSession: Boolean(editorSession ?? sourceEditorSession),
        surface: readPanelSurface(document.getElementById("bpanel")),
      });
      if (recovered.ok) return;
      const panel = document.getElementById("bpanel");
      if (!panel) return;
      panel.innerHTML = `<div class="ws-editor-error" role="alert"><strong>编辑器未能自动恢复</strong><span>${escapeHtml(recovered.reason)}</span><button type="button" id="chapter-reload">重新加载章节</button></div>`;
      document.getElementById("chapter-reload")?.addEventListener("click", () => void openChapterSafely(workspaceId, chapterId));
    });
  }

  /**
   * 正在进行中的章节渲染数。
   *
   * 挂载护栏（ensureEditorInvariant）守的是**静止态**不变式：要么有活会话，要么
   * 面板上有显式的空态/加载中/错误界面。渲染在飞时这两条可以同时为假——新渲染
   * 刚拆掉旧会话、新编辑器还没立起来——那是合法的过渡态，不是缺陷。
   *
   * 实测过的误报路径：渲染 A 被渲染 B 取代后静默退出，A 的收尾检查恰好落在
   * B 的「拆完、没建完」窗口里。链条上最后一个渲染必然跑完（没人再取代它），
   * 要么建起会话、要么画出错误界面，不变式自然恢复，无需补检。
   */
  let chapterRendersInFlight = 0;

  async function renderChapterContent(workspaceId: string, chapterId: string): Promise<void> {
    chapterRendersInFlight += 1;
    try {
      await renderChapterContentInner(workspaceId, chapterId);
    } catch (error) {
      // 渲染中的异常一个都不许静默。历史事故（2026-08-13）：术语高亮乱序 add 在
      // EditorState.create 里抛错，而所有调用点都是 void ...then() 不挂 catch——
      // 用户看到的是永久空壳编辑器，护栏与门禁全是假阴性。这里是最后的兜底出口。
      const message = error instanceof Error ? error.message : String(error);
      runtimeWindow.pushEvent?.(`章节渲染失败：${message}`, "err");
      const panel = document.getElementById("bpanel");
      if (panel) {
        panel.innerHTML = `<div class="ws-editor-error" role="alert"><strong>章节渲染失败</strong><span>${escapeHtml(message)}</span><button type="button" id="chapter-reload">重新加载章节</button></div>`;
        document.getElementById("chapter-reload")?.addEventListener("click", () => void openChapterSafely(workspaceId, chapterId));
      }
    } finally {
      chapterRendersInFlight -= 1;
    }
  }

  /**
   * 章节渲染的中止点记录（DIAG-01）。
   *
   * 「新建章节/新书之后进去看到的是别的正文」这个现象，可能的断点有五处，
   * 而它们**全都是静默 return**——现场什么都不留，事后无从分辨是哪一处。
   * 这里让每一次中止都自报家门：请求的是哪一章、在哪一步停的。
   *
   * 只记录、不改行为。`window.__lighteeChapterRender` 供控制台事后翻查。
   */
  function bailChapterRender(chapterId: string, step: string, detail?: string, silent = false): void {
    const note = `章节「${chapterId}」渲染中止于 ${step}${detail ? ` · ${detail}` : ""}`;
    const log = ((window as BridgeWindow & { __lighteeChapterRender?: string[] }).__lighteeChapterRender ??= []);
    log.push(note);
    if (log.length > 50) log.shift();
    // silent：这一次渲染是被**更新的**渲染取代的，属于竞态防护正常生效，不是故障。
    // 把它当红字推给作者，等于让人去追一件本来就该发生的事。仍进内部日志备查。
    if (!silent) runtimeWindow.pushEvent?.(note, "err");
  }

  async function renderChapterContentInner(workspaceId: string, chapterId: string): Promise<void> {
    transitionContext(workspaceId, chapterId, "bi");
    const token = workbenchContext.capture("chapter", "chapter-load");
    const sequence = chapterRenderSequence;
    const panel = document.getElementById("bpanel");
    if (!panel) { bailChapterRender(chapterId, "找不到 #bpanel"); return; }
    // 先取数据，**取到了再拆旧的**。
    //
    // 从前的顺序是「清面板 → 拆会话 → 取数据 → 建新编辑器」，代价有两个：
    // 切一章连闪两次（编辑器 → 占位 → 新编辑器），而本地读一章通常只有几十毫秒；
    // 而且拆完到建好之间，面板既没有会话也没有显式空态，正是挂载护栏要抓的那个窗口。
    // 反过来排序，两个问题一起消失：旧编辑器一直活到新数据就位。
    //
    // 只有当加载慢到人能察觉（>220ms）才让占位出场——那时它是有用的反馈，不是闪烁。
    const slowLoadHint = window.setTimeout(() => {
      if (sequence !== chapterRenderSequence) return;
      editorSession?.autosave.dispose();
      editorSession?.editor.destroy();
      sourceEditorSession?.controller.dispose();
      editorSession = null;
      sourceEditorSession = null;
      chapterEditor = null;
      panel.innerHTML = `<div class="ws-editor-loading" aria-live="polite">正在加载章节「${escapeHtml(chapterId)}」…</div>`;
    }, 220);
    const result = await adapter.loadChapter(workspaceId, chapterId);
    window.clearTimeout(slowLoadHint);
    // 被更新的渲染取代时**不拆**：那一份已经归新的渲染管，这里动手会拆掉它刚建好的会话
    if (sequence !== chapterRenderSequence || !workbenchContext.accepts(token)) {
      bailChapterRender(chapterId, sequence !== chapterRenderSequence ? "渲染序号已过期" : "上下文令牌已失效", undefined, true);
      return;
    }
    editorSession?.autosave.dispose();
    editorSession?.editor.destroy();
    sourceEditorSession?.controller.dispose();
    editorSession = null;
    sourceEditorSession = null;
    chapterEditor = null;
    const currentPanel = document.getElementById("bpanel");
    if (!result.ok || !currentPanel) {
      if (currentPanel) currentPanel.innerHTML = `<div class="ws-editor-error" role="alert"><strong>章节正文加载失败</strong><span>${escapeHtml(result.ok ? "编辑器容器未就绪" : result.message)}</span><button type="button" id="chapter-reload">重新加载</button></div>`;
      document.getElementById("chapter-reload")?.addEventListener("click", () => void openChapterSafely(workspaceId, chapterId));
      runtimeWindow.pushEvent?.(result.ok ? "编辑器容器未就绪" : `加载章节失败：${result.message}`, "err");
      return;
    }
    const content = result.content;
    // 竞态防护：loadChapter 期间用户可能已切走 tab → 不再覆盖当前面板
    const activeTabNow = document.querySelector("[data-btab].on")?.getAttribute("data-btab");
    if (activeTabNow && activeTabNow !== "bi") { bailChapterRender(chapterId, "当前 tab 不是正文编辑", activeTabNow); return; }
    // 拿到手的必须就是要的那一章。后端按 id 解析，返回别的 id 说明解析链上有东西错位了——
    // 静默画上去就是「点新章出现旧正文」，而现场此时已经无从追查。
    if (content.chapterId !== chapterId) {
      bailChapterRender(chapterId, "后端返回了另一章", `实收 ${content.chapterId}`);
    }
    activeChapterContent = {
      workspaceId,
      chapterId: content.chapterId,
      revision: content.revision,
      source: content.paragraphs.map((paragraph) => ({ id: paragraph.id, text: paragraph.source })),
      translation: content.paragraphs.map((paragraph) => ({ id: paragraph.id, text: paragraph.translation })),
    };
    needsChapterReload = false;
    panel.innerHTML = `
      <div class="continuous-editor-shell" style="height:100%;min-height:0;display:flex;flex-direction:column">
        <div class="continuous-editor" id="chapter-editor-host" contenteditable="false" style="flex:1;min-height:0;overflow:auto"></div>
        ${editorFootBar({
          chapterId,
          meta: `${content.paragraphs.length} 段`,
          stateId: "save-hint",
          stateLabel: "无改动",
          keys: [
            { keys: ["Ctrl", "S"], label: "保存" },
            { keys: ["Ctrl", "↑", "↓"], label: "跳过空行", optional: true },
          ],
        })}
      </div>`;
    const host = document.getElementById("chapter-editor-host");
    if (!host) return;
    const sourceById = new Map(content.paragraphs.map((paragraph) => [paragraph.id, paragraph.source]));
    let session: EditorSession | null = null;
    const controller = new AutosaveController({
      adapter: {
        saveDraft: async (request) => {
          const outcome = await adapter.saveDraft(request.workspaceId, request.chapterId, request.baseRevision, request.paragraphs);
          return outcome.ok
            ? { ok: true, revision: outcome.revision }
            : { ok: false, code: outcome.code, revision: outcome.revision };
        },
        checkpoint: async () => ({ ok: false }),
      },
      workspaceId,
      chapterId,
      delayMs: 1000,
      onStateChange: (state) => {
        if (!session || !workbenchContext.accepts(token) || editorSession !== session) return;
        showSaveState(state);
        if (state.phase !== "saved") return;
        activeChapterContent!.revision = state.baseRevision;
        activeChapterContent!.translation = session.latestParagraphs.map((paragraph) => ({ id: paragraph.id, text: paragraph.translation }));
        // 每次落盘顺手记下光标所在段：「上次编辑」恢复的就是这一段。
        // 跟着保存走而不是跟着光标走——光标每动一下都写盘是噪音，保存才代表「编辑过」。
        const editedParagraph = session.editor.currentParagraphId();
        void adapter.setSession({ workspaceId, chapterId, ...(editedParagraph ? { paragraphId: editedParagraph } : {}), savedAt: Date.now() });
        const footCount = document.querySelector(FOOT_COUNT_SELECTOR);
        if (footCount) footCount.textContent = `${session.latestParagraphs.length} 段`;
        void refreshInfoCells();
      },
    });
    controller.reset(content.revision);
    chapterEditor = paragraphEditor({
      parent: host,
      paragraphs: ParagraphDocument.fromParagraphs(
        content.paragraphs.map((paragraph) => ({ id: paragraph.id, text: paragraph.translation })),
      ),
      editable: true,
      focusMode: false,
      cursorMode: "smooth",
      showSources: sourceVisible,
      onChange: () => {
        if (!session || !editorSession || editorSession !== session) return;
        const doc = session.editor.getDocument();
        session.latestParagraphs = doc.paragraphs.map((paragraph) => ({
          id: paragraph.id,
          source: sourceById.get(paragraph.id) ?? "",
          translation: paragraph.text,
        }));
        session.autosave.markModified(session.latestParagraphs);
      },
      onCommand: (command) => {
        if (command === "save") void controller.flush();
      },
    });
    session = {
      workspaceId,
      chapterId,
      token,
      editor: chapterEditor,
      autosave: controller,
      latestParagraphs: content.paragraphs.map((paragraph) => ({ id: paragraph.id, source: paragraph.source, translation: paragraph.translation })),
    };
    editorSession = session;
    // 编辑器视觉设置（字号/原文色/间距/术语/证据）——真实读 settings IPC
    const settings = await adapter.readEditorSettings(workspaceId);
    // 这个 await 期间编辑器可能已经被换掉或销毁（切 tab、空原文分支、重入渲染都会
    // 把闭包里的 `chapterEditor` 置 null）。原来的守卫只看渲染序号，漏掉了「序号没变
    // 但编辑器没了」这一支，于是 setVisual 打在 null 上——作者实测：打开章节先弹
    // 「章节渲染失败：Cannot read properties of null」，重试后又能打开。
    // 往下一律用 `session.editor`：本次渲染建出来的那一个，不会被别人从下面抽走。
    if (sequence !== chapterRenderSequence || activeChapterContent?.chapterId !== chapterId) return;
    if (editorSession !== session || chapterEditor !== session.editor) return;
    const editor = session.editor;
    if (settings.ok) {
      editorVisual = settings.settings;
      editor.setVisual({
        fontSize: settings.settings.fontSize,
        sourceColor: settings.settings.sourceColor,
        paragraphGap: settings.settings.paragraphGap,
        termHighlight: settings.settings.termHighlight,
        sourceLink: settings.settings.sourceLink,
        focusCenter: settings.settings.focusCenter,
      });
      // 光标外观（动画/闪烁/形状）
      editor.setCursorAppearance({
        mode: settings.settings.cursorAnimate ? "smooth" : "off",
        blink: settings.settings.cursorBlink,
        shape: settings.settings.cursorShape,
      });
    }
    editor.setContextSources(content.paragraphs.map((paragraph) => ({ id: paragraph.id, text: paragraph.source })));
    // 术语高亮：查询本章术语（原文/译文对）
    void loadChapterTerms(workspaceId, chapterId);
    // 方案 B：header 三栏（身份 | 通用信息栏目 | 保存态+原文开关）接管真实数据
    void updateChapterHeader();
    // 空原文章节（只有标题、无正文原文）→ 显示引导，替代空编辑器
    // 原判据 `length > 1` 会把单字符正文段（「…」「─」）误判为无原文并弹出空态引导（M-8）。
    const hasRealSource = hasAuthorVisibleSource(content.paragraphs);
    if (!hasRealSource) {
      // 会话必须一并清干净：只销毁编辑器不清 editorSession，护栏会看到「会话存活但
      // 编辑器宿主不在」，自动重渲染又走回这条分支——死循环到「未能自动恢复」错误卡
      controller.dispose();
      editor.destroy();
      chapterEditor = null;
      editorSession = null;
      renderEmptySourceGuide(panel, chapterId);
      return;
    }
    editor.view.focus();
  }

  // 术语高亮数据：terms.query（本章术语）→ 传入编辑器
  async function loadChapterTerms(workspaceId: string, chapterId: string): Promise<void> {
    const token = workbenchContext.capture("chapter", "chapter-terms");
    const terms = await adapter.queryTerms(workspaceId, chapterId);
    if (!workbenchContext.accepts(token) || editorSession?.workspaceId !== workspaceId || editorSession.chapterId !== chapterId) return;
    editorSession.editor.setTerms(terms.map((term) => ({ source: term.ja, target: term.zh })));
  }

  // ===== 方案 B：工作台三栏 header（身份 | 通用信息栏目 | 保存态+原文开关） =====
  // 通用 info-cell：label + 数值 + 可选进度条 + 副文案 + 点击跳转
  interface InfoCellData {
    key: string;            // 稳定标识（diff 用）
    label: string;
    value: string;          // 可为 HTML（含 <b>/class）
    detail: string;
    progress: number | null; // null = 无进度条
    accent?: boolean;
    onClick?: () => void;
  }
  function cellContentHTML(cell: InfoCellData): string {
    return `<div class="ic-top"><span class="ic-label">${escapeHtml(cell.label)}</span><span class="ic-val${cell.accent ? " accent" : ""}">${cell.value}</span></div>`
      + (cell.progress !== null ? `<div class="ic-track"><i style="width:${Math.min(100, Math.max(0, cell.progress))}%"></i></div>` : "")
      + `<div class="ic-detail">${escapeHtml(cell.detail)}</div>`;
  }
  function createCellEl(cell: InfoCellData): HTMLElement {
    const el = document.createElement("div");
    el.className = "info-cell multi";
    el.dataset.key = cell.key;
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    el.innerHTML = cellContentHTML(cell);
    if (cell.onClick) {
      el.onclick = cell.onClick;
      el.addEventListener("keydown", (event) => { if (event.key === "Enter") cell.onClick?.(); });
    }
    return el;
  }
  function updateCellEl(el: HTMLElement, cell: InfoCellData): void {
    el.innerHTML = cellContentHTML(cell);
    el.onclick = cell.onClick ?? null;
  }
  // 多格渲染 + 消失过渡：新增格淡入（translateY→0），消失格先 .hiding（淡出+缩小）再移除
  function renderInfoCells(cells: InfoCellData[]): void {
    const container = document.getElementById("b-info");
    if (!container) return;
    // 清理设计稿静态 demo 残留格（无 dataset.key）——bridge 渲染后只保留真实格
    container.querySelectorAll<HTMLElement>(".info-cell:not([data-key])").forEach((el) => el.remove());
    const existing = new Map<string, HTMLElement>();
    container.querySelectorAll<HTMLElement>(".info-cell").forEach((el) => {
      const key = el.dataset.key ?? "";
      if (key) existing.set(key, el);
    });
    const nextKeys = new Set(cells.map((cell) => cell.key));
    // 消失：加 hiding 过渡（淡出 + scale(.94)），320ms 后真正移除
    for (const [key, el] of existing) {
      if (!nextKeys.has(key)) {
        el.classList.add("hiding");
        const remover = (): void => { if (el.parentNode === container) el.remove(); };
        window.setTimeout(remover, 320);
      }
    }
    // 新增（淡入）/ 更新
    for (const cell of cells) {
      const el = existing.get(cell.key);
      if (el && !el.classList.contains("hiding")) {
        updateCellEl(el, cell);
      } else if (!el) {
        const node = createCellEl(cell);
        container.appendChild(node);
        // 双 rAF：先插入（opacity:0）再下一帧加 .shown 触发淡入过渡
        requestAnimationFrame(() => requestAnimationFrame(() => node.classList.add("shown")));
      }
    }
  }
  // 根据真实章节状态 + 术语数 + 已译段数构建 info-cell 列表（0-N 个，完成即消失）
  function buildInfoCells(
    chapter: WorkspaceRecord["volumes"][number]["chapters"][number] | undefined,
    _confirmedTerms: number,
    content: { translation: Array<{ text: string }> },
    live: LiveProgress | null = null,
  ): InfoCellData[] {
    const state = chapter?.state ?? "ready";
    const total = content.translation.length;
    const translated = content.translation.filter((p) => p.text.trim().length > 0).length;
    const cells: InfoCellData[] = [];
    // 全部完成（已批准）→ 无任何信息格（消失，布局不变）
    if (state === "approved") return cells;
    // 翻译未完成 → 翻译进度格
    if (translated < total) {
      // 正文正在流的时候，这一格显示**活动位置**而不是已落盘段数。
      // 理由是实测的：整章 250 秒里 `translate.progress` 只发 0% 与 100% 两种，
      // 而 `translated` 要等整章落盘才动——于是进度条 250 秒不动然后跳满。
      // 活动位置的文案写明「落盘后才计入已译」，不冒充已完成（live-progress.ts）。
      cells.push({
        key: "translate",
        label: chapterStateLabel(state),
        value: `<b>${live ? live.value : `${translated}/${total}`}</b>`,
        detail: live ? live.detail : total > 0 ? `${Math.round((translated / total) * 100)}% 已译` : "尚未翻译",
        progress: live ? live.percent : total > 0 ? Math.round((translated / total) * 100) : null,
        accent: true,
        onClick: () => { document.querySelector<HTMLElement>("[data-btab=\"bi\"]")?.click(); },
      });
    }
    // 术语待确认格：待术语候选系统完成后，有未确认候选时在此 push（key:"terms"）
    // 已译==总 且非 approved → 当前无未完成动作 → 返回空（消失）
    return cells;
  }
  // 轻量刷新 info-cell（保存后调用：进度更新 / 完成即消失）
  async function refreshInfoCells(): Promise<void> {
    if (!activeWorkspace || !activeChapterContent) return;
    const token = workbenchContext.capture("chapter", "info-cells");
    const workspace = activeWorkspace;
    const content = activeChapterContent;
    const chapterId = content.chapterId;
    let chapter: WorkspaceRecord["volumes"][number]["chapters"][number] | undefined;
    for (const volume of workspace.volumes) {
      const found = volume.chapters.find((candidate) => candidate.id === chapterId);
      if (found) { chapter = found; break; }
    }
    const terms = await adapter.queryTerms(workspace.id, chapterId);
    if (!workbenchContext.accepts(token)) return;
    renderInfoCells(buildInfoCells(chapter, terms.length, content));
  }
  // 更新 header：身份（作品·卷 / 章节标题）+ 通用信息栏目 + 按钮绑定
  async function updateChapterHeader(): Promise<void> {
    if (!activeWorkspace || !activeChapterContent) return;
    const token = workbenchContext.capture("chapter", "chapter-header");
    const workspace = activeWorkspace;
    const content = activeChapterContent;
    const chapterId = content.chapterId;
    let volumeId = "";
    let chapter: WorkspaceRecord["volumes"][number]["chapters"][number] | undefined;
    for (const volume of workspace.volumes) {
      const found = volume.chapters.find((candidate) => candidate.id === chapterId);
      if (found) { volumeId = volume.id; chapter = found; break; }
    }
    const kicker = document.getElementById("header-kicker");
    if (kicker) kicker.textContent = chapter ? `${workspace.name} · ${volumeId}` : chapterId;
    const title = document.getElementById("header-chapter-title");
    if (title) title.textContent = chapter?.title ?? chapterId;
    // 通用信息栏目：真实数据（已译段进度）→ 多格渲染（完成即消失，带过渡）
    const terms = await adapter.queryTerms(workspace.id, chapterId);
    if (!workbenchContext.accepts(token)) return;
    renderInfoCells(buildInfoCells(chapter, terms.length, content));
    bindHeaderButtons();
  }
  // header 右栏按钮（原文显隐 / 编辑原文）——每次 renderChapterContent 后刷新绑定与显隐
  function bindHeaderButtons(): void {
    const toggleBtn = document.getElementById("toggle-src");
    if (toggleBtn) {
      toggleBtn.classList.toggle("off", !sourceVisible);
      toggleBtn.onclick = () => {
        sourceVisible = !sourceVisible;
        toggleBtn.classList.toggle("off", !sourceVisible);
        chapterEditor?.setShowSources(sourceVisible);
      };
    }
    const editSourceBtn = document.getElementById("edit-source");
    if (editSourceBtn) {
      editSourceBtn.style.display = editorVisual?.sourceEditable ? "inline-flex" : "none";
      editSourceBtn.onclick = () => void openSourceEditor();
    }
  }

  // ===== 编辑器视觉设置（真实 settings IPC）：供设置面板/测试调用，实时应用到当前编辑器 =====
  // 设置归属工作区：当前工作区；主页（未打开工作区）时 fallback 最近打开的工作区，
  // 否则启动中心的设置卡点击无效果（activeWorkspace 为 null）
  async function resolveSettingsWorkspace(): Promise<WorkspaceRecord | null> {
    if (activeWorkspace) return activeWorkspace;
    const list = await adapter.list();
    const ready = list.filter((workspace) => workspace.status === "ready" || workspace.status === undefined);
    if (ready.length === 0) return null;
    return [...ready].sort((a, b) => b.openedAt - a.openedAt)[0];
  }

  async function updateEditorSettings(patch: Partial<{ fontSize: number; sourceColor: "dim" | "soft" | "faint"; paragraphGap: "tight" | "natural" | "loose"; termHighlight: "highlight" | "underline" | "none"; sourceLink: boolean; focusCenter: boolean; cursorAnimate: boolean; cursorBlink: boolean; cursorShape: "block" | "beam" | "underline"; sourceEditable: boolean }>): Promise<boolean> {
    const target = await resolveSettingsWorkspace();
    if (!target) return false;
    const current = editorVisual ?? { fontSize: 18, sourceColor: "faint", paragraphGap: "natural", termHighlight: "highlight", sourceLink: true, focusCenter: true, cursorAnimate: true, cursorBlink: false, cursorShape: "block", sourceEditable: false };
    const next = { ...current, ...patch };
    let revision = await (async () => {
      const read = await adapter.readEditorSettings(target.id);
      return read.ok ? read.revision : 0;
    })();
    const keys = Object.keys(patch) as Array<keyof typeof next>;
    for (const key of keys) {
      const write = await adapter.writeEditorSetting(target.id, key, next[key] as number | string, revision);
      if (!write.ok) return false;
      revision = write.revision;
    }
    editorVisual = next;
    chapterEditor?.setVisual(next);
    chapterEditor?.setCursorAppearance({
      mode: next.cursorAnimate ? "smooth" : "off",
      blink: next.cursorBlink,
      shape: next.cursorShape,
    });
    // 原文可编辑开关变化 → 刷新「✎ 编辑原文」按钮显隐
    const editSourceBtn = document.getElementById("edit-source");
    if (editSourceBtn) editSourceBtn.style.display = next.sourceEditable ? "inline-flex" : "none";
    runtimeWindow.pushEvent?.(`设置已更新 · ${Object.keys(patch).join(", ")}`, "ok");
    return true;
  }

  // ===== 状态栏真实化：footer 术语/翻译/审校 Agent 状态 =====
  // ===== 快捷键面板（Ctrl+/ 或 ? 呼出；Esc / 点遮罩关闭） =====
  let shortcutsBound = false;
  function showShortcutsPanel(): void {
    // 强制移除任何残留 overlay（不依赖淡出 timer——后台窗口 setTimeout 会被节流到 1s+）
    document.getElementById("shortcuts-overlay")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "shortcuts-overlay";
    overlay.className = "sc-overlay";
    overlay.innerHTML = `
      <div class="sc-panel" role="dialog" aria-label="快捷键">
        <h3>快捷键</h3>
        <div class="sc-sub">Lightee 翻译工作台</div>
        <div class="sc-sec">
          <div class="sc-sec-title">编辑</div>
          <div class="sc-row"><span>软换行（段内换行）</span><span class="sc-keys"><kbd class="sc-k">Enter</kbd></span></div>
          <div class="sc-row"><span>拆分段落</span><span class="sc-keys"><kbd class="sc-k">Ctrl</kbd><kbd class="sc-k">Enter</kbd></span></div>
          <div class="sc-row"><span>合并到上一段（段首）</span><span class="sc-keys"><kbd class="sc-k">Backspace</kbd></span></div>
          <div class="sc-row"><span>保存</span><span class="sc-keys"><kbd class="sc-k">Ctrl</kbd><kbd class="sc-k">S</kbd></span></div>
          <div class="sc-row"><span>撤销 / 重做</span><span class="sc-keys"><kbd class="sc-k">Ctrl</kbd><kbd class="sc-k">Z</kbd><span class="sc-or">/</span><kbd class="sc-k">Ctrl</kbd><kbd class="sc-k">Y</kbd></span></div>
        </div>
        <div class="sc-sec">
          <div class="sc-sec-title">段落导航</div>
          <div class="sc-row"><span>跳转上一段 / 下一段（不停在段间空行）</span><span class="sc-keys"><kbd class="sc-k">Ctrl</kbd><kbd class="sc-k">↑</kbd><span class="sc-or">/</span><kbd class="sc-k">Ctrl</kbd><kbd class="sc-k">↓</kbd></span></div>
          <div class="sc-row"><span>上移 / 下移当前段</span><span class="sc-keys"><kbd class="sc-k">Alt</kbd><kbd class="sc-k">↑</kbd><span class="sc-or">/</span><kbd class="sc-k">Alt</kbd><kbd class="sc-k">↓</kbd></span></div>
        </div>
        <div class="sc-sec">
          <div class="sc-sec-title">查找</div>
          <div class="sc-row"><span>查找 / 替换（同一块面板）</span><span class="sc-keys"><kbd class="sc-k">Ctrl</kbd><kbd class="sc-k">F</kbd><span class="sc-or">/</span><kbd class="sc-k">Ctrl</kbd><kbd class="sc-k">H</kbd></span></div>
          <div class="sc-row"><span>下一个 / 上一个匹配</span><span class="sc-keys"><kbd class="sc-k">Enter</kbd><span class="sc-or">/</span><kbd class="sc-k">Shift</kbd><kbd class="sc-k">Enter</kbd></span></div>
          <div class="sc-row"><span>关闭查找面板</span><span class="sc-keys"><kbd class="sc-k">Esc</kbd></span></div>
        </div>
        <div class="sc-sec">
          <div class="sc-sec-title">全局</div>
          <div class="sc-row"><span>底栏主按钮（按当前状态）</span><span class="sc-keys"><kbd class="sc-k">Ctrl</kbd><kbd class="sc-k">T</kbd></span></div>
          <div class="sc-row"><span>本章检查</span><span class="sc-keys"><kbd class="sc-k">Ctrl</kbd><kbd class="sc-k">R</kbd></span></div>
          <div class="sc-row"><span>导出</span><span class="sc-keys"><kbd class="sc-k">Ctrl</kbd><kbd class="sc-k">X</kbd></span></div>
          <div class="sc-row"><span>设置</span><span class="sc-keys"><kbd class="sc-k">Ctrl</kbd><kbd class="sc-k">,</kbd></span></div>
          <div class="sc-row"><span>快捷键面板</span><span class="sc-keys"><kbd class="sc-k">Ctrl</kbd><kbd class="sc-k">/</kbd></span></div>
        </div>
      </div>`;
    overlay.addEventListener("click", (event) => { if (event.target === overlay) hideShortcutsPanel(); });
    document.body.appendChild(overlay);
    // 强制 reflow 渲染初始态（opacity:0）后加 .open —— 过渡动画可靠（rAF/setTimeout 在后台窗口会被节流）
    void overlay.getBoundingClientRect();
    overlay.classList.add("open");
  }
  function hideShortcutsPanel(): void {
    const overlay = document.getElementById("shortcuts-overlay");
    if (!overlay) return;
    overlay.classList.remove("open");
    window.setTimeout(() => overlay.remove(), 200);
  }
  /**
   * 底栏「本章检查」（Ctrl+R）。切到审校 tab 并跑那一遍确定性扫描。
   *
   * 这个位置原来挂的是「审校」，onclick 只往事件流写一行字——按了什么都不会发生。
   * 换成真实动作后，快捷键也必须真的可用（见 bindFooterShortcuts）。
   */
  function runChapterCheck(): void {
    if (!activeWorkspace) { runtimeWindow.pushEvent?.("本章检查需要先打开工作区", "err"); return; }
    const reviewTab = document.querySelector<HTMLElement>("[data-btab=\"review\"]");
    if (reviewTab && !reviewTab.classList.contains("on")) reviewTab.click();
    // 面板要先挂上才有 #review-start；点过去之后下一帧再发起
    requestAnimationFrame(() => {
      const start = document.getElementById("review-start") as HTMLButtonElement | null;
      if (!start || start.disabled) { runtimeWindow.showToast?.("这一章还没有译文，没什么可检查的", { duration: 2600 }); return; }
      start.click();
    });
  }

  /** 输入中不抢快捷键：CodeMirror 用 contenteditable，光判 input/textarea 会把编辑器里的剪切吃掉 */
  function isTypingTarget(event: KeyboardEvent): boolean {
    const target = event.target as HTMLElement | null;
    if (!target) return false;
    if (target.matches?.("input,textarea,select")) return true;
    return Boolean(target.closest?.("[contenteditable=\"true\"],.cm-content"));
  }

  /**
   * 底栏快捷键（RS-UI 2026-08-13）。
   *
   * 那几个 `Ctrl+X` / `Ctrl+T` / `Ctrl+,` 的 kbd 标签一直是**装饰**：设计稿的键盘处理
   * 开头就是 `if(__lighteeLegacyVariantRoute===false)return`，而真实应用正是把它设成
   * false 的那一个。写在界面上的快捷键必须真的能按——否则和那个假的「审校」按钮是同一种错。
   *
   * Ctrl+R 必须 preventDefault：不拦就是浏览器/Electron 的「重新加载」，未保存的编辑随之丢失。
   */
  function bindFooterShortcuts(): void {
    window.addEventListener("keydown", (event) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || isTypingTarget(event)) return;
      const key = event.key.toLowerCase();
      if (key === "r") { event.preventDefault(); runChapterCheck(); return; }
      if (key === "t") { event.preventDefault(); document.getElementById("main-act-btn")?.click(); return; }
      if (key === "x") { event.preventDefault(); runtimeWindow.toggleExport?.(); return; }
      if (key === ",") { event.preventDefault(); runtimeWindow.openSettings?.(); return; }
    });
  }

  function bindShortcutsPanel(): void {
    if (shortcutsBound) return;
    shortcutsBound = true;
    bindFooterShortcuts();
    window.addEventListener("keydown", (event) => {
      const plainQuestion = event.key === "?" && !event.ctrlKey && !event.altKey && !event.metaKey;
      const ctrlSlash = event.ctrlKey && !event.altKey && !event.metaKey && (event.key === "/" || event.key === "?");
      if (plainQuestion || ctrlSlash) {
        event.preventDefault();
        if (document.getElementById("shortcuts-overlay")) hideShortcutsPanel();
        else showShortcutsPanel();
      } else if (event.key === "Escape") {
        hideShortcutsPanel();
      }
    });
  }

  // ===== 忙碌指示器 =====
  /**
   * 长调用期间后端可能一两分钟不发任何事件——语气归属实测单次 118 秒，术语提取整轮 316 秒。
   * 那段时间里界面上没有任何东西在动，用户唯一能得出的结论就是「卡死了」。
   *
   * 所以秒表**由前端自己走**，不等后端喂数据：只要还没收到 done/failed，秒数就在涨。
   * 这是「还活着」唯一可信的证据。文案用真实的当前动作，不编造进度百分比——
   * 编出来的进度条比没有进度条更伤人。
   */
  const busy = {
    /** 每个在跑的动作：key → { 文案, 开始时刻 } */
    jobs: new Map<string, { what: string; since: number }>(),
    timer: 0,
  };

  /**
   * 各动作的耗时量级（实测：单章翻译 30–96 秒，单章工作区术语提取 248–316 秒）。
   * 只陈述量级，不写安慰话也不替用户决定该做什么——秒表已经说明它没停，
   * 用户需要的只是「这个数字涨到多少算正常」。
   */
  const BUSY_SCALE: Record<string, string> = {
    // terminologist 这一档已删：译前通读全书那一趟随 ADR-0007 退役，术语改由译者
    // 在翻译的同一次调用里登记。留着一条描述不存在的动作的耗时参考，只会在
    // 它某天被别的路径撞上时给出一个凭空的数字。
    translator: "耗时参考 · 单章通常 1–2 分钟",
    reviewer: "耗时参考 · 单章通常不到 1 分钟",
    bookreview: "耗时参考 · 随章数增长，整本通常几分钟",
    // D10：思考量跨模型不稳定，跑批不编预估数字
    scope: "耗时参考 · 时长视模型思考量而定，可随时在章边界停下",
  };

  /** 短动作不显示量级说明，否则秒表刚起步就先挂一行废话。 */
  const BUSY_SCALE_AFTER_SECONDS = 20;

  function busyNote(key: string, seconds: number): string {
    return seconds >= BUSY_SCALE_AFTER_SECONDS ? BUSY_SCALE[key] ?? "" : "";
  }

  function paintBusy(): void {
    const card = document.getElementById("busy-card");
    if (!card) return;
    // 多个动作并行时显示跑得最久的那个：用户最想知道的是"最慢的还要多久"
    let oldest: { key: string; what: string; since: number } | null = null;
    for (const [key, job] of busy.jobs) if (!oldest || job.since < oldest.since) oldest = { key, ...job };
    if (!oldest) {
      card.classList.remove("on");
      if (busy.timer) { window.clearInterval(busy.timer); busy.timer = 0; }
      return;
    }
    const seconds = Math.max(0, Math.round((Date.now() - oldest.since) / 1000));
    const time = document.getElementById("busy-time");
    const sub = document.getElementById("busy-sub");
    const note = document.getElementById("busy-note");
    // 标题行是固定的品牌口吻，正在做什么放次行——招呼语每秒重刷没有意义，
    // 而具体阶段（「收集术语证据（2/7）」）才是用户真正在读的那一行。
    if (time) time.textContent = seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
    if (sub) sub.textContent = oldest.what;
    if (note) note.textContent = busyNote(oldest.key, seconds);
    card.classList.add("on");
    if (!busy.timer) busy.timer = window.setInterval(paintBusy, 1000);
  }

  /**
   * 后端阶段文案带「@ Ns」时刻（给日志与事件流用）。卡片里必须去掉：
   * 它和卡片自己的秒表并排出现时是两个含义不同的数字（实测「@ 3s」旁边写着「37 秒」），
   * 用户只会以为有一个是错的。卡片上的时间只有一个来源，就是它自己的秒表。
   */
  function stripBackendElapsed(text: string): string {
    return text.replace(/\s*@\s*\d+s\s*$/, "");
  }

  /** 开始/更新一个动作。同一 key 重复调用只换文案，不重置秒表——否则计时永远停在 0。 */
  function busyStart(key: string, what: string): void {
    const existing = busy.jobs.get(key);
    busy.jobs.set(key, { what: stripBackendElapsed(what), since: existing?.since ?? Date.now() });
    paintBusy();
  }

  function busyStop(key: string): void {
    busy.jobs.delete(key);
    paintBusy();
    // 动作结束 → 思考块也该收摊。后端的 done 与 agent.status 的 done 谁先到不定，
    // 两边都收一次，界面才不会停在「正在思考」上。
    if (busy.jobs.size === 0) { thinkingState = emptyThinking(); paintThinking(); }
  }

  /**
   * 思考直播（TR-04）。状态机在 `thinking-view.ts`（纯函数、可单测），
   * 这里只负责把它画出来。
   *
   * 秒表只能说明「还没停」；这一行说明「在想什么」。2026-08-12 的跑批里
   * ch003 连废三次、耗掉 380 秒，而界面上只有一个一直在涨的数字——
   * 「正常地慢」与「卡在第 3 次重试」在用户眼里完全一样。
   */
  let thinkingState: ThinkingState = emptyThinking();
  let thinkingExpanded = false;

  function paintThinking(): void {
    const box = document.getElementById("busy-think");
    if (!box) return;
    const view = describeThinking(thinkingState);
    if (!view.visible) {
      box.hidden = true;
      box.classList.remove("running");
      return;
    }
    box.hidden = false;
    box.classList.toggle("running", view.running);
    const summary = document.getElementById("busy-think-summary");
    if (summary) summary.textContent = view.summary;
    const tail = document.getElementById("busy-think-tail");
    // 展开时不再显示打字机尾巴：同一段内容出现两遍只会让人以为是两段
    if (tail) { tail.hidden = thinkingExpanded; tail.textContent = thinkingExpanded ? "" : view.tail; }
    const full = document.getElementById("busy-think-full");
    if (full) { full.hidden = !thinkingExpanded; if (thinkingExpanded) full.textContent = thinkingState.text; }
    const head = document.getElementById("busy-think-head");
    head?.setAttribute("aria-expanded", thinkingExpanded ? "true" : "false");
  }

  /**
   * 会话式时间轴。状态机在 `run-transcript.ts`（纯函数、可单测），这里只画。
   *
   * 与思考直播的分工：那一行答「在想什么」，这一段答「刚才那两分钟**经过了什么**」。
   * 秒表 + 思考块合起来仍然答不了后者——工具轮的交接、门禁、审校、状态迁移
   * 全都发生在同一个转圈图标底下。
   */
  /**
   * 正文直播。
   *
   * 与思考直播的分工：那一行是**旁证**（模型在想什么），这一段是**交付物本身**
   * （译文正在被写出来）。所以视觉上亮一档，且不折叠——正在产出的东西不该要人点开才看得见。
   *
   * 光流扫过的是刚到达的那一段（`.fresh`，两秒后摘掉）。它标记的是真实的产出位置；
   * 加在静态文本上就只是装饰了。
   */
  let bodyText = "";
  let bodyFresh = "";
  let bodyParagraphId = "";
  let bodyRunning = false;
  let bodyFreshTimer = 0;
  /**
   * 正文流属于哪一章。
   *
   * `agent.text` 的 payload 不带 `operation`，所以 `acceptsAgentEvent` 对它**不校验章节**
   * （只校验工作区）。同一工作区里换一章看，上一章仍在跑的正文就会流进当前视图——
   * 「正在写第 119 段」会挂在错误的章节标题底下。这个字段就是拦这件事的。
   */
  let bodyChapterId = "";
  /** 尾部保留量：忙碌卡是个小角落，留最近这些字就够看出"在动"了 */
  const BODY_TAIL_CHARS = 300;

  function paintBody(): void {
    const box = document.getElementById("busy-body");
    if (!box) return;
    if (!bodyText) { box.hidden = true; return; }
    box.hidden = false;
    const head = document.getElementById("busy-body-head");
    if (head) {
      head.textContent = bodyRunning
        ? `正在写译文${bodyParagraphId ? ` · ${bodyParagraphId}` : ""}`
        : `译文已写完 · ${bodyText.length} 字`;
    }
    const el = document.getElementById("busy-body-text");
    if (!el) return;
    // 只留尾部：整章几千字挂在 DOM 上没有意义，而且会把小卡片撑爆
    const tail = bodyText.length > BODY_TAIL_CHARS ? bodyText.slice(-BODY_TAIL_CHARS) : bodyText;
    const freshAt = bodyFresh && tail.endsWith(bodyFresh) ? tail.length - bodyFresh.length : -1;
    el.textContent = "";
    if (freshAt > 0) el.append(document.createTextNode(tail.slice(0, freshAt)));
    if (freshAt >= 0) {
      const span = document.createElement("span");
      span.className = "fresh";
      span.textContent = bodyFresh;
      el.append(span);
    } else {
      el.append(document.createTextNode(tail));
    }
    el.scrollTop = el.scrollHeight;
  }

  /**
   * 章节头那格的活动位置重画。
   *
   * 刻意**不走** `refreshInfoCells()`：那条路要 `adapter.queryTerms` 一次 IPC 往返，
   * 而这里一章会调 125 次。`renderInfoCells` 本身是按 key 原地更新的，
   * 且 `buildInfoCells` 用不到术语数（参数是 `_confirmedTerms`），所以零 IPC。
   *
   * 节流到 200ms：正文最密时一秒到七八段，逐段重画只是白烧帧。
   */
  let liveRepaintTimer = 0;
  function repaintLiveProgress(): void {
    if (liveRepaintTimer) return;
    liveRepaintTimer = window.setTimeout(() => {
      liveRepaintTimer = 0;
      if (!activeWorkspace || !activeChapterContent) return;
      const chapterId = activeChapterContent.chapterId;
      // 正文流属于别的章 → 不画。跨章串台会让「第 119 段」挂在错误的章节标题下面。
      if (bodyChapterId && bodyChapterId !== chapterId) return;
      let chapter: WorkspaceRecord["volumes"][number]["chapters"][number] | undefined;
      for (const volume of activeWorkspace.volumes) {
        const found = volume.chapters.find((candidate) => candidate.id === chapterId);
        if (found) { chapter = found; break; }
      }
      // 位次从段落表里查，不从 id 里解析：id 是身份不是序号，作者在中间插的段
      // 拿到的编号大于它的位置（p0126 排第 2）。查不到就不传，由那边兜底。
      const liveIndex = activeChapterContent.translation.findIndex((paragraph) => paragraph.id === bodyParagraphId);
      const live = liveWritingPosition({
        paragraphId: bodyParagraphId,
        ...(liveIndex >= 0 ? { index: liveIndex + 1 } : {}),
        total: activeChapterContent.translation.length,
        state: chapter?.state ?? "ready",
        running: bodyRunning,
      });
      renderInfoCells(buildInfoCells(chapter, 0, activeChapterContent, live));
    }, 200);
  }

  function pushBody(delta: string, paragraphId: string, done: boolean, chapterId = ""): void {
    if (chapterId) bodyChapterId = chapterId;
    if (paragraphId) bodyParagraphId = paragraphId;
    if (delta) {
      bodyText += delta;
      bodyFresh = delta;
      // 光流只标"刚到"的那一段。不摘掉的话，最后一段会永远亮着，
      // 而"永远亮着的高亮"等于没有高亮。
      if (bodyFreshTimer) window.clearTimeout(bodyFreshTimer);
      bodyFreshTimer = window.setTimeout(() => { bodyFresh = ""; bodyFreshTimer = 0; paintBody(); }, 2000);
    }
    bodyRunning = !done;
    paintBody();
    repaintLiveProgress();
  }

  /** 新一章开工：上一章的正文不该留在卡片上 */
  function resetBody(): void {
    if (bodyFreshTimer) { window.clearTimeout(bodyFreshTimer); bodyFreshTimer = 0; }
    if (liveRepaintTimer) { window.clearTimeout(liveRepaintTimer); liveRepaintTimer = 0; }
    bodyText = ""; bodyFresh = ""; bodyParagraphId = ""; bodyRunning = false; bodyChapterId = "";
    paintBody();
  }

  let transcript: TranscriptState = emptyTranscript();
  let flowExpanded = false;

  /**
   * 把一条 IPC 事件喂进流水并重画。
   *
   * 时刻由这里给（`Date.now()`），纯函数不读时钟——这样 `run-transcript.ts` 的用例
   * 才能把时间当输入喂进去，断言「历时 800ms」这种事。
   */
  function feedTranscript(event: TranscriptEvent): void {
    const next = reduceTranscript(transcript, event, Date.now());
    if (next === transcript) return;
    transcript = next;
    paintFlow();
  }

  function paintFlow(): void {
    const box = document.getElementById("busy-flow");
    const jump = document.getElementById("busy-jump");
    if (!box) return;
    const activity = currentActivity(transcript);
    if (!activity || transcript.steps.length === 0) {
      box.hidden = true;
      if (jump) jump.hidden = true;
      return;
    }
    box.hidden = false;
    if (jump) jump.hidden = false;
    const summary = document.getElementById("busy-flow-summary");
    if (summary) summary.textContent = `运行流水 · ${transcript.steps.length} 步 · ${activity.text}`;
    const head = document.getElementById("busy-flow-head");
    head?.setAttribute("aria-expanded", flowExpanded ? "true" : "false");
    const list = document.getElementById("busy-flow-list");
    if (!list) return;
    list.hidden = !flowExpanded;
    if (!flowExpanded) return;
    list.innerHTML = transcript.steps.map((step) => `
      <span class="bf-step bf-${escapeHtml(step.kind)}${step.running ? " bf-running" : ""}">
        <span class="bf-at">${(step.at / 1000).toFixed(1)}s</span>
        <span class="bf-rail"><span class="bf-dot"></span></span>
        <span class="bf-body">
          <span class="bf-title">${escapeHtml(step.title)}</span>
          ${step.detail ? `<br><span class="bf-detail">${escapeHtml(step.detail)}</span>` : ""}
        </span>
      </span>`).join("");
    // 跟到最新一步：运行中的人看的是末尾，不是开头
    list.scrollTop = list.scrollHeight;
  }

  // 事件委托而不是直接绑节点：busy-card 由 ui-shell-runtime 在运行时渲染，
  // 这个闭包建立时它可能还不存在——直接绑定会静默变成空操作（而且不报错，
  // 表现为「点了没反应」这种最难查的故障）。
  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (target?.closest?.("#busy-think-head")) {
      thinkingExpanded = !thinkingExpanded;
      paintThinking();
      return;
    }
    if (target?.closest?.("#busy-flow-head")) {
      flowExpanded = !flowExpanded;
      paintFlow();
      return;
    }
    const jump = target?.closest?.("[data-busy-jump]") as HTMLElement | null;
    if (jump) {
      // 快捷去处。**只跳转，不做任何别的动作**——弹窗是引路的，不是替人做决定的。
      // 走既有的 tab 按钮与章节项，不另建一套导航：多一条路径就多一处会走岔的地方。
      const where = jump.getAttribute("data-busy-jump");
      if (where === "agent" || where === "review") {
        document.querySelector<HTMLElement>(`[data-btab="${where}"]`)?.click();
      } else if (where === "chapter" && transcript.chapterId) {
        document.querySelector<HTMLElement>(`[data-cid="${CSS.escape(transcript.chapterId)}"]`)?.click();
      }
    }
  });

  /** Agent 名 → 人话动作。文案要说清"在为你做什么"，不是内部阶段名。 */
  const BUSY_LABELS: Record<string, string> = {
    // 同 BUSY_SCALE：译前通读全书那一趟已不存在，而所有 terminologist 状态都是 done，
    // 这条忙碌文案既到不了、又在描述一件软件不再做的事。
    translator: "正在翻译这一章",
    reviewer: "正在审校这一章",
    bookreview: "AI 正在做全书一致性审校",
    import: "正在导入原文",
    scope: "正在按范围翻译",
  };

  // ===== 范围跑批（RS-2）：命令栏状态 =====
  /** 当前跑批视图（translate.scopeChanged 驱动；null=没有跑批） */
  let scopeRun: ScopeRunView | null = null;
  /** runScope 调用在飞（点了开始、started 事件还没到的间隙也算） */
  let scopeInvokePending = false;
  /** 命令栏勾选状态。null=下次渲染取默认（未译全选，D4） */
  let composerSelection: Set<string> | null = null;
  /** 章节可选框展开态 */
  let composerOpen = false;

  // ===== 阶段 A：AI 翻译接入（translate.run + 进度事件 → 事件流/状态栏/info-cell/文件树） =====
  function bindAiEvents(): void {
    if ((window as BridgeWindow & { __aiBound?: boolean }).__aiBound) return;
    (window as BridgeWindow & { __aiBound?: boolean }).__aiBound = true;
    const api = (window as BridgeWindow & { lightee?: { onEvent?: (name: string, listener: (event: unknown) => void) => void } }).lightee;
    const on = (name: string, cb: (event: unknown) => void): void => { try { api?.onEvent?.(name, cb); } catch { /* 事件通道不可用时忽略 */ } };
    on("translate.progress", (event: unknown) => {
      const payload = (event as { payload?: { workspaceId?: string; chapterId?: string; progress?: number; message?: string } })?.payload;
      if (!acceptsChapterEvent({ workspaceId: activeWorkspace?.id ?? null, chapterId: activeChapterContent?.chapterId ?? null }, payload ?? {})) return;
      const message = payload?.message ?? "翻译中…";
      feedTranscript({ type: "translate.progress", ...payload });
      runtimeWindow.pushEvent?.(message, "act");
      // 进度百分比不再进页脚：忙碌卡与侧栏进度条已经在说同一件事，页脚活动行只报动作
      if (payload?.progress !== undefined && payload.progress >= 1) { busyStop("translator"); void updateSideFoot(); }
      else busyStart("translator", message === "翻译中…" ? BUSY_LABELS.translator! : message);
    });
    on("review.progress", (event: unknown) => {
      const payload = (event as { payload?: { workspaceId?: string; chapterId?: string; progress?: number; message?: string } })?.payload;
      if (!acceptsChapterEvent({ workspaceId: activeWorkspace?.id ?? null, chapterId: activeChapterContent?.chapterId ?? null }, payload ?? {})) return;
      feedTranscript({ type: "review.progress", ...payload });
      runtimeWindow.pushEvent?.(payload?.message ?? "审校中…", "act");
    });
    on("bookReview.progress", (event: unknown) => {
      const payload = (event as { payload?: { workspaceId?: string; status?: string; message?: string; progress?: number } })?.payload;
      if (!acceptsWorkspaceEvent({ workspaceId: activeWorkspace?.id ?? null, chapterId: activeChapterContent?.chapterId ?? null }, payload ?? {})) return;
      if (payload?.message) runtimeWindow.pushEvent?.(payload.message, "act");
      agentStates["bookreview"] = { status: payload?.status ?? "running", message: payload?.message ?? "", ts: Date.now() };
      if (payload?.status === "running" || payload?.status === undefined) busyStart("bookreview", payload?.message || BUSY_LABELS.bookreview!);
      else busyStop("bookreview");
      const agentTab = document.querySelector("[data-btab=\"agent\"].on");
      if (agentTab) void renderAgentConsole();
      const reviewTab = document.querySelector("[data-btab=\"review\"].on");
      if (reviewTab && activeWorkspace) void updateBookReviewStatus(activeWorkspace.id);
    });
    on("bookReview.changed", (event: unknown) => {
      const payload = (event as { payload?: { workspaceId?: string } })?.payload;
      const workspaceId = payload?.workspaceId;
      if (workspaceId && workspaceId === activeWorkspace?.id && activeBtab() === "review") void updateBookReviewStatus(workspaceId);
    });
    /**
     * 页脚活动行：整条页脚状态区只有这一格（作者裁定 2026-08-13）。
     *
     * 从前是三格常驻状态（术语/翻译/审校）。翻译与审校那两格复述的是章节树与侧栏
     * 进度条已经说过的话；而术语那格会被长消息占满（「思考能力探测完成: … (7/7 档可用)」），
     * 把右侧的度量与操作整排挤出可视区。
     *
     * 现在只回答「此刻在做什么」：一行、会截断、空闲即整格隐藏。完成态留 4 秒再收，
     * 让「刚刚做完了什么」有机会被读到——立刻清空等于没说过。
     */
    let footerActivityTimer = 0;
    /**
     * agent id → 页脚用的短名。
     *
     * 不能借用 `AGENT_LABELS`：那张表的键是**调用标签**（`translate` / `book-review:reduce`），
     * 不是 agent id，查不中就把 `terminologist` 这种内部标识原样显给用户。
     */
    const AGENT_SHORT_NAMES: Record<string, string> = {
      terminologist: "术语",
      translator: "翻译",
      reviewer: "审校",
      manager: "编排",
      compiler: "导出",
    };
    function setFooterActivity(agent: string, text: string, status?: string): void {
      const host = document.getElementById("footer-activity");
      const label = document.getElementById("footer-activity-text");
      if (!host || !label) return;
      if (footerActivityTimer) { window.clearTimeout(footerActivityTimer); footerActivityTimer = 0; }
      const name = AGENT_SHORT_NAMES[agent] ?? agent;
      const line = text ? `${name} · ${text}` : name;
      label.textContent = line;
      host.setAttribute("title", line); // 截断后仍要能读到全文
      host.dataset.agent = agent;
      host.dataset.tone = status ?? "";
      host.hidden = false;
      if (status === "done" || status === "failed" || status === "idle") {
        footerActivityTimer = window.setTimeout(() => { host.hidden = true; footerActivityTimer = 0; }, 4000);
      }
    }

    on("agent.status", (event: unknown) => {
      const payload = (event as { payload?: { agent?: string; status?: string; message?: string; kind?: string; workspaceId?: string; chapterId?: string; operation?: string } })?.payload;
      if (!acceptsAgentEvent({ workspaceId: activeWorkspace?.id ?? null, chapterId: activeChapterContent?.chapterId ?? null }, payload ?? {})) return;
      const agent = payload?.agent;
      const text = payload?.message ?? payload?.status ?? "";
      if (agent) agentStates[agent] = { status: payload?.status ?? "running", message: text, ts: Date.now() };
      if (agent) {
        // 后端阶段文案比通用标签更具体，有就用它；但告警不是动作——它只进事件流，
        // 否则卡片会显示成「正在：语气归属未完成…」。此时保留上一条动作文案不动。
        if (payload?.status !== "running") busyStop(agent);
        else if (payload.kind !== "warning") busyStart(agent, text || BUSY_LABELS[agent] || "正在处理");
      }
      // 流水只收告警：running/done 与状态迁移是同一件事，两条都画等于说两遍
      if (payload) {
        feedTranscript({ type: "agent.status", agent, ...payload });
      }
      if (agent) setFooterActivity(agent, text, payload?.status);
      if (agent === "terminologist") {
        // 提取期间徽标单独一态：既不是「待确认 N」，也绝不能冒充「已完成」
        termExtracting = payload?.status === "running";
        if (activeWorkspace) void updateTermBadge(activeWorkspace.id);
      }
      if (text) runtimeWindow.pushEvent?.(text, "act");
      // Agent 控制台 tab 激活时实时刷新 + 侧栏 token 统计刷新
      const agentTab = document.querySelector("[data-btab=\"agent\"].on");
      if (agentTab) void renderAgentConsole();
      void updateSideFoot();
      if (payload?.status === "done" || payload?.status === "failed") void updateMainActButton();
    });
    on("translate.scopeChanged", (event: unknown) => {
      const payload = (event as { payload?: ScopeChangedPayload & { workspaceId?: string } })?.payload;
      if (!payload) return;
      if (!acceptsWorkspaceEvent({ workspaceId: activeWorkspace?.id ?? null, chapterId: activeChapterContent?.chapterId ?? null }, payload)) return;
      if (payload.phase === "notification-clicked") {
        // D13：结束通知被点击 → 落 Agent 控制台
        document.querySelector<HTMLElement>("[data-btab=\"agent\"]")?.click();
        return;
      }
      scopeRun = reduceScopeEvent(scopeRun, payload);
      if (payload.phase === "started") {
        busyStart("scope", `开始工作：共 ${payload.total} 章`);
      } else if (payload.phase === "chapter-started") {
        // 忙碌卡 k/N。per-chapter 的 translate.progress 是章级作用域事件，
        // 批里非当前打开章的进度会被正确抑制——跑批全程的可见性由这条工作区级事件负责。
        busyStart("scope", `${busyScopePrefix(scopeRun)}正在翻译「${scopeChapterTitle(payload.chapterId)}」`);
      } else if (payload.phase === "chapter-skipped") {
        // D6：跳过必须出声
        runtimeWindow.pushEvent?.(`跳过「${scopeChapterTitle(payload.chapterId)}」：${payload.reason ?? ""}`, "warn");
      } else if (payload.phase === "chapter-done") {
        // 每章落盘后树上状态立即可见（D11：不标「排队中」，只画真实状态）
        void refreshTree();
      } else if (payload.phase === "finished") {
        busyStop("scope");
      }
      renderComposer();
      void updateMainActButton();
    });
    on("agent.text", (event: unknown) => {
      const payload = (event as { payload?: { label?: string; paragraphId?: string; delta?: string; done?: boolean; workspaceId?: string; chapterId?: string } })?.payload;
      if (!payload?.label) return;
      if (!acceptsAgentEvent({ workspaceId: activeWorkspace?.id ?? null, chapterId: activeChapterContent?.chapterId ?? null }, payload)) return;
      pushBody(payload.delta ?? "", payload.paragraphId ?? "", payload.done === true, payload.chapterId ?? "");
    });
    on("agent.thinking", (event: unknown) => {
      const payload = (event as { payload?: { label?: string; attempt?: number; thinking?: string; delta?: string; done?: boolean; workspaceId?: string; chapterId?: string } })?.payload;
      if (!payload?.label) return;
      if (!acceptsAgentEvent({ workspaceId: activeWorkspace?.id ?? null, chapterId: activeChapterContent?.chapterId ?? null }, payload)) return;
      // 思考块在流水上是一整格（增量攒起来），在直播那一行是打字机——同一份事件，两种用法
      feedTranscript({ type: "agent.thinking", ...payload });
      thinkingState = reduceThinking(thinkingState, {
        label: payload.label,
        ...(payload.attempt === undefined ? {} : { attempt: payload.attempt }),
        ...(payload.thinking ? { thinking: payload.thinking } : {}),
        delta: payload.delta ?? "",
        ...(payload.done ? { done: true } : {}),
      }, Date.now());
      paintThinking();
    });
    on("workspace.changed", (event: unknown) => {
      const payload = (event as { payload?: { workspaceId?: string } })?.payload;
      if (payload?.workspaceId === activeWorkspace?.id) void refreshTree();
    });
    on("terminology.changed", (event: unknown) => {
      const payload = (event as { payload?: { workspaceId?: string } })?.payload;
      if (payload?.workspaceId !== activeWorkspace?.id || !activeWorkspace) return;
      void updateTermBadge(activeWorkspace.id);
      void updateMainActButton();
      void renderSideTerms();
      if (activeBtab() === "terms") void renderTermsPanel(activeWorkspace.id);
    });
    on("chapter.stateChanged", (event: unknown) => {
      const payload = (event as { payload?: { workspaceId?: string; chapterId?: string; to?: string; from?: string; reason?: string } })?.payload;
      if (!acceptsWorkspaceEvent({ workspaceId: activeWorkspace?.id ?? null, chapterId: activeChapterContent?.chapterId ?? null }, payload ?? {})) return;
      // 流水的开工信号（translating）与终态（approved/stuck）都来自这条事件
      if (payload?.to === "translating") resetBody();
      feedTranscript({ type: "chapter.stateChanged", ...payload });
      void refreshTree();
      updateRealStatusBar();
      void refreshInfoCells();
      void updateSideFoot();
      void updateMainActButton();
      // 翻译结果在后台完成后已经落盘；正文编辑器不能继续显示翻译开始前的内存快照。
      // 只刷新当前章节，且仅在有新译文状态时触发，避免普通状态事件覆盖作者正在编辑的草稿。
      const activeChapterId = activeChapterContent?.chapterId;
      const isCurrentChapter = Boolean(activeWorkspace && payload?.workspaceId === activeWorkspace.id && payload?.chapterId === activeChapterId);
      const hasTranslation = payload?.to === "translated" || payload?.to === "reviewing" || payload?.to === "approved";
      if (isCurrentChapter && hasTranslation && activeWorkspace) {
        needsChapterReload = true;
        const savePhase = editorSession?.autosave.getState().phase ?? "idle";
        const sourceSavePhase = sourceEditorSession?.controller.getState().phase ?? "idle";
        const hasAuthorChanges = [savePhase, sourceSavePhase].some((phase) => phase === "modified" || phase === "saving" || phase === "failed" || phase === "conflict");
        if (activeBtab() === "bi" && !hasAuthorChanges) {
          editorSession?.autosave.dispose();
          editorSession?.editor.destroy();
          sourceEditorSession?.controller.dispose();
          editorSession = null;
          sourceEditorSession = null;
          chapterEditor = null;
          void openChapterSafely(activeWorkspace.id, activeChapterId!)
            .then(() => ensureEditorInvariant("state-changed"));
        }
      }
    });
  }

  // ===== 审校 tab：章节审校 + 全书两级批准真实状态 =====
  type BookReviewAdvice = {
    chapterIds: string[];
    type: string;
    severity: string;
    found?: string;
    expected?: string;
    repairInstruction?: string;
    evidenceRefs?: Array<{ source: string; context: string }>;
  };

  type BookReviewView = {
    /** RV-06 三态：没跑过 / 正在跑 / 有建议 */
    status: "none" | "running" | "advisory";
    scope?: string[];
    summary?: { high: number; medium: number; low: number };
    issues?: BookReviewAdvice[];
    staleReason?: string;
    authorEditedSinceReview?: boolean;
    lastError?: string;
    skippedChapters?: string[];
  };

  /**
   * 章节状态 → 这一格该说的话。
   *
   * 修正一处杜撰：`translated` 曾写成「待你确认」，但状态机里根本没有对应动作
   * （`chapter.accept` 只收 stuck，`translated → approved` 是被禁止的转移），
   * 于是这句话在向作者索要一个他做不到的操作。
   */
  function chapterApprovalText(state: string): string {
    switch (state) {
      // 「随时可继续修改」被砍掉：编辑器一直可编辑，说一遍是废话（作者裁定 2026-08-13）
      case "approved": return "已定稿";
      case "translated": return "已翻译，未定稿";
      case "stuck": return "有问题没修掉，等你看一眼";
      case "translating": case "reviewing": case "revising": return "正在处理";
      default: return "未译";
    }
  }

  async function runBookReview(workspaceId: string): Promise<void> {
    const token = workbenchContext.capture("tab", "book-review-run");
    const button = document.getElementById("book-review-run") as HTMLButtonElement | null;
    if (button?.disabled) return;
    if (button) { button.disabled = true; button.textContent = "全文审校中…"; button.setAttribute("aria-busy", "true"); }
    const api = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<{ ok: boolean; value?: BookReviewView; error?: { message?: string } }> } }).lightee;
    runtimeWindow.pushEvent?.("开始全文一致性审校", "act");
    busyStart("bookreview", BUSY_LABELS.bookreview!);
    const result = await api?.invoke("bookReview.run", { workspaceId }).finally(() => busyStop("bookreview"));
    if (!workbenchContext.accepts(token)) return;
    if (!result?.ok) {
      runtimeWindow.pushEvent?.(result?.error?.message ?? "全文审校失败", "err");
      runtimeWindow.showToast?.(result?.error?.message ?? "全文审校失败，请检查 Agent 控制台", { duration: 4200 });
    } else {
      runtimeWindow.pushEvent?.("全文一致性审校完成", "ok");
    }
    await updateBookReviewStatus(workspaceId);
  }

  const ADVICE_TYPE_LABELS: Record<string, string> = {
    tone: "语气漂移",
    accuracy: "译意偏差",
    term_missing: "术语缺失",
    term_drift: "术语漂移",
    consistency: "前后不一致",
    style: "文风不统一",
  };

  /** 一条建议的展示卡片。每条可跳到对应章节——建议看得见、去得了，才叫建议。 */
  function adviceCardHtml(advice: BookReviewAdvice, index: number): string {
    const target = advice.chapterIds[0];
    const label = ADVICE_TYPE_LABELS[advice.type] ?? advice.type;
    const body = advice.repairInstruction || [advice.found, advice.expected].filter(Boolean).join(" → ");
    const where = advice.chapterIds.length > 0 ? advice.chapterIds.join("、") : "";
    return `
      <div class="advice-item" data-advice="${index}"${target ? ` data-advice-chapter="${escapeHtml(target)}"` : ""}>
        <div class="advice-head"><span class="advice-type">${escapeHtml(label)}</span>${where ? `<span class="advice-where">${escapeHtml(where)}</span>` : ""}</div>
        ${body ? `<div class="advice-body">${escapeHtml(body)}</div>` : ""}
      </div>`;
  }

  /**
   * 全书 AI 审校的界面入口开关（作者裁定 2026-08-13：先停用）。
   *
   * 停用的理由是作者实测下来的账：整本书喂进模型，token 消耗巨大，而回来的建议
   * 值不值这个价还没被证实；期间还撞上停止入口不好找、取消后显示成失败调用等问题。
   * 与其带着一个「贵且未验证」的功能上路，不如先把入口收起来。
   *
   * **只收界面，不删代码**：IPC（bookReview.run/status/cancel）、服务层、engine 的
   * 通读实现、审校规则注入全部原样保留并继续受测试保护。日后要用，把这里改回 true
   * 就整条链路回来——删掉再重做的成本远高于留一个开关。
   */
  const BOOK_AI_REVIEW_ENABLED = false;

  async function updateBookReviewStatus(workspaceId: string): Promise<void> {
    if (!BOOK_AI_REVIEW_ENABLED) return;
    const token = workbenchContext.capture("tab", "book-review-status");
    const root = document.getElementById("review-approval");
    if (!root) return;
    const api = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<{ ok: boolean; value?: BookReviewView; error?: { message?: string } }> } }).lightee;
    const result = await api?.invoke("bookReview.status", { workspaceId });
    if (!root.isConnected || !workbenchContext.accepts(token) || activeWorkspace?.id !== workspaceId) return;
    if (!result?.ok || !result.value) {
      root.innerHTML = `<div class="review-approval-note">读不到全书 AI 审校的状态。</div>`;
      return;
    }
    const book = result.value;
    const advices = book.issues ?? [];
    const hasChapters = (activeWorkspace?.volumes.flatMap((volume) => volume.chapters).length ?? 0) > 0;

    // RV-06：这里只回答一个问题——「全书 AI 审校跑过没有，说了什么」。
    // 它不再是门禁，所以没有「通过/待修」这种判决词，也没有需要作者去接受的否决。
    // 文案不写「让轻小译读」（作者裁定 2026-08-13）：动作的执行者是 AI 模型，
    // 把软件拟人成读者既不准确，也让人以为这是某种人工审读。
    const headline = book.status === "running"
      ? "AI 全书审校进行中…"
      : book.status === "none"
        ? "还没做过全书 AI 审校"
        : advices.length > 0 ? `${advices.length} 条建议` : "全书 AI 审校完成，没有发现问题";
    const notes: string[] = [];
    if (book.lastError) notes.push(book.lastError);
    if (book.staleReason) notes.push(`这些建议基于改动前的译文（${book.staleReason}），可以重新审校一次。`);
    else if (book.authorEditedSinceReview) notes.push("你在这次审校之后改过译文，这些建议可能已经过时。");
    if (book.skippedChapters?.length) notes.push(`有 ${book.skippedChapters.length} 章还没有译文，本次没审。`);

    root.innerHTML = `
      <div class="advice-head-row">
        <b>${escapeHtml(headline)}</b>
        ${advices.length > 0 ? `<span class="advice-disclaimer">来自 AI 的建议，酌情参考</span>` : ""}
      </div>
      ${notes.map((note) => `<div class="review-approval-note">${escapeHtml(note)}</div>`).join("")}
      ${advices.length > 0 ? `<div class="advice-list">${advices.map((advice: BookReviewAdvice, index: number) => adviceCardHtml(advice, index)).join("")}</div>` : ""}
      ${book.status === "running"
        ? `<button class="tw-btn" id="book-review-cancel">停止审校</button>`
        : `<button class="tw-btn" id="book-review-run" ${hasChapters ? "" : `disabled title="还没有章节，先导入原文"`}>${book.status === "none" ? "全书 AI 审校（可选）" : "重新做一次全书 AI 审校"}</button>`}`;

    document.getElementById("book-review-run")?.addEventListener("click", () => void runBookReview(workspaceId));
    document.getElementById("book-review-cancel")?.addEventListener("click", () => void (async () => {
      const api2 = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<{ ok: boolean; value?: { status?: string } }> } }).lightee;
      const cancelled = await api2?.invoke("bookReview.cancel", { workspaceId });
      runtimeWindow.pushEvent?.(cancelled?.ok && cancelled.value?.status === "cancelling" ? "正在停止全书 AI 审校…" : "当前没有正在进行的全书 AI 审校", "act");
      await updateBookReviewStatus(workspaceId);
    })());
    root.querySelectorAll<HTMLElement>("[data-advice-chapter]").forEach((item) => {
      item.addEventListener("click", () => {
        const chapterId = item.dataset.adviceChapter;
        if (chapterId) void openChapterSafely(workspaceId, chapterId);
      });
    });
  }

  // RV-06：decideBookReview 已删除——建议不构成否决，没有需要作者去「接受」的东西。

  /** 当前打开章节的工作流状态（读不到就按「还没翻译」处理） */
  function activeChapterState(): string {
    const chapterId = activeChapterContent?.chapterId;
    if (!chapterId) return "imported";
    return activeWorkspace?.volumes.flatMap((volume) => volume.chapters).find((item) => item.id === chapterId)?.state ?? "imported";
  }

  // ===== RV-05 章节审校面板 =====
  type ReviewIssueView = {
    type: string; severity: string; location: string;
    message?: string; suggestion?: string; found?: string; expected?: string;
    paragraphId?: string; paragraphIds?: string[]; termJa?: string;
  };
  type ReviewRunView = { issueCount?: number; issues?: ReviewIssueView[]; checksRun?: string[]; noTranslation?: boolean };
  /** EX-06 追溯改名复查队列（形状与 ipc-contract 的 RenameReviewResult 一致） */
  type RenameReviewView = {
    entries: Array<{ id: string; oldZh: string; newZh: string; chapterId: string; paragraphId: string; reason: string; excerpt: string; resolvedAt?: number }>;
    pending: number;
  };

  /** 检查项 id → 人话。与 engine 的 CHECK_LABELS 一一对应；缺项按原 id 显示，不编。 */
  const CHECK_LABELS: Record<string, string> = {
    dialogue_format: "对话引号配对", quote_style_leftover: "引号风格残留",
    untranslated: "整段未译", kana_note: "假名注音", no_translate: "禁翻词保留", pun_note: "谐音梗译注",
    // 旧 id：存量审校报告仍带它，留一条映射免得历史条目退化成裸 id
    ruby_leftover: "假名注音",
    kana_leftover: "残留假名",
  };
  const ISSUE_LABELS: Record<string, string> = {
    ...CHECK_LABELS,
    no_translate_missing: "禁翻词被译掉", pun_note_missing: "谐音梗缺译注",
  };

  /**
   * 本章审校的覆盖面（面板顶部「这一步查什么」）。
   *
   * 与 engine `ALWAYS_RUN` + `PARAGRAPH_CHECKS` 同源同序——写死一份漂亮的清单，
   * 而实际跑的是另一套，就是在对作者撒谎。真正跑了哪几项以 `checksRun` 为准
   * （零问题时那份清单会逐项列出）。
   */
  /**
   * 本章审校逐项的判据（面板顶部）。
   *
   * 只写「查这六项」等于没说——作者看到条目仍不知道软件凭什么这么判。
   * 这里每一条写清**实际的判据**，与 engine 的实现逐条对齐（reviewer-scan.ts）：
   * 界面上说的和代码里跑的必须是同一件事，否则说明本身就是新的误导来源。
   */
  const CHAPTER_SCAN_SCOPE: string[] = [
    "检查 全章 “ 和 ” 的数量是否配平，并指出哪几段自身就不配对",
    "检查 译文里是否还留着「」等不属于当前引号风格的引号",
    "检查 是否有整段没译：逐行算假名占比，超过 35% 判为未译（短于 6 字的行跳过）",
    "检查 是否有形如（とおる）的平假名注音；片假名与拉丁字母的括注不算",
    "检查 术语表里标了禁翻的词，是否在译文里原样保留",
    "检查 术语表里写了译注的谐音梗，译法有没有出现、那一段有没有跟着译注（译注留空的梗不查）",
  ];

  /**
   * 判不准的检查要把不确定性说出来（作者实测：假名注音多半是**有意保留**，
   * 而不是原文残留）。这类条目摆在这里是「请你看一眼」，不是「这里错了」——
   * 标题已经改成中性词，再补一句话说清该怎么判，免得作者以为软件下了判决。
   */
  /** 判据一句话说清：条目本身只给位置，凭什么这么判要写出来 */
  const ISSUE_HINTS: Record<string, string> = {
    kana_note: "译文里有平假名括注。可能是原文注音没删，也可能是你有意标读音——软件分不出这两种。",
    pun_note_missing: "术语表里这条谐音梗写了译注，但译文里译法所在的那一段没跟着这条译注。把术语表里的译注留空，这个梗就只要求译法统一，这条不再出现。",
    no_translate_missing: "术语表标了这个词禁翻，原文里有，译文里没有原样出现。",
  };

  // 术语族检查（term_missing / term_drift / count_mismatch）已在 engine 侧整族删除，
  // 「打开术语条目」按钮现在只挂在还带 termJa 的两类问题上。
  const TERM_ISSUE_TYPES = new Set(["no_translate_missing", "pun_note_missing"]);
  const INDEX_COLLAPSED_KEY = "lightee.review.indexCollapsed";

  /** 本章上一次检查的结果（面板重绘与就地标注共用一份） */
  let lastReview: { chapterId: string; view: ReviewRunView; at: number } | null = null;

  function severityOf(issue: ReviewIssueView): "high" | "medium" | "low" {
    return issue.severity === "high" ? "high" : issue.severity === "low" ? "low" : "medium";
  }

  /** 问题 → 段落标注表。同一段有多条时取最重的一条着色。 */
  function issueMarksFrom(issues: readonly ReviewIssueView[]): Record<string, "high" | "medium" | "low"> {
    const rank = { low: 0, medium: 1, high: 2 };
    const marks: Record<string, "high" | "medium" | "low"> = {};
    for (const issue of issues) {
      const severity = severityOf(issue);
      for (const id of issue.paragraphIds ?? (issue.paragraphId ? [issue.paragraphId] : [])) {
        const current = marks[id];
        if (!current || rank[severity] > rank[current]) marks[id] = severity;
      }
    }
    return marks;
  }

  function issueRowHtml(issue: ReviewIssueView, index: number): string {
    const target = issue.paragraphId ?? issue.paragraphIds?.[0];
    const label = ISSUE_LABELS[issue.type] ?? issue.type;
    const detail = issue.found && issue.expected ? `${issue.found} → ${issue.expected}` : (issue.found ?? issue.expected ?? "");
    // 定位不到段落时别把文件名摆出来冒充信息：作者看到的是「ch002.md」这种东西，
    // 既不知道该看哪里，点上去也没有任何反应（它本来就不是按钮）。直说没定位到。
    const tail = target
      ? `<span class="rv-issue-jump">定位</span>`
      : `<span class="rv-issue-loc" title="${escapeHtml(issue.location ?? "")}">未定位到具体段落</span>`;
    const termButton = issue.termJa && TERM_ISSUE_TYPES.has(issue.type)
      ? `<button class="rv-issue-term" data-issue-term="${escapeHtml(issue.termJa)}">打开术语条目</button>`
      : "";
    return `
      <div class="rv-issue rv-${severityOf(issue)}" data-issue="${index}"${target ? ` data-issue-para="${escapeHtml(target)}"` : ""}>
        <div class="rv-issue-head"><b>${escapeHtml(label)}</b>${tail}</div>
        ${detail ? `<div class="rv-issue-body">${escapeHtml(detail)}</div>` : ""}
        ${ISSUE_HINTS[issue.type] ? `<div class="rv-issue-hint">${escapeHtml(ISSUE_HINTS[issue.type]!)}</div>` : ""}
        ${termButton}
      </div>`;
  }

  /** 零问题不是一句孤零零的 ✓：N 来自后端真实执行的检查清单（RV-04 checksRun）。 */
  function passedHtml(checksRun: readonly string[]): string {
    if (checksRun.length === 0) return `<div class="rv-passed"><b>没有发现问题</b></div>`;
    const items = checksRun.map((id) => `<span>${escapeHtml(CHECK_LABELS[id] ?? id)}</span>`).join("");
    return `
      <div class="rv-passed">
        <b>${checksRun.length} 项检查全部通过</b>
        <details class="rv-checks"><summary>看看查了哪些</summary><div class="rv-check-list">${items}</div></details>
      </div>`;
  }

  function renderReviewResults(): void {
    const results = document.getElementById("review-results");
    if (!results) return;
    const view = lastReview?.chapterId === activeChapterContent?.chapterId ? lastReview?.view : null;
    if (!view) {
      results.innerHTML = `<div class="review-real-empty">还没检查过这一章。</div>`;
      return;
    }
    if (view.noTranslation) {
      results.innerHTML = `<div class="review-real-empty">本章还没有可审校的译文。</div>`;
      return;
    }
    const issues = view.issues ?? [];
    if (issues.length === 0) {
      results.innerHTML = passedHtml(view.checksRun ?? []);
      return;
    }
    const collapsed = localStorage.getItem(INDEX_COLLAPSED_KEY) === "1";
    const byType = new Map<string, number>();
    for (const issue of issues) byType.set(issue.type, (byType.get(issue.type) ?? 0) + 1);
    const breakdown = [...byType.entries()].map(([type, count]) => `${ISSUE_LABELS[type] ?? type} ${count}`).join(" · ");
    // 索引列表是总账，正文里的标注才是主视图——所以它可以收起，收起状态记住。
    results.innerHTML = `
      <div class="rv-index-head">
        <b>本章 ${issues.length} 个问题</b>
        <span class="rv-index-breakdown">${escapeHtml(breakdown)}</span>
        <button class="rv-index-toggle" id="rv-index-toggle">${collapsed ? "展开列表" : "收起列表"}</button>
      </div>
      <div class="rv-index-list" id="rv-index-list"${collapsed ? " hidden" : ""}>${issues.map((issue, index) => issueRowHtml(issue, index)).join("")}</div>`;

    document.getElementById("rv-index-toggle")?.addEventListener("click", () => {
      const next = localStorage.getItem(INDEX_COLLAPSED_KEY) !== "1";
      localStorage.setItem(INDEX_COLLAPSED_KEY, next ? "1" : "0");
      renderReviewResults();
    });
    results.querySelectorAll<HTMLElement>("[data-issue-para]").forEach((row) => {
      row.addEventListener("click", (event) => {
        if ((event.target as HTMLElement).dataset.issueTerm !== undefined) return;
        const paragraphId = row.dataset.issuePara;
        if (paragraphId) void jumpToParagraph(paragraphId);
      });
    });
    results.querySelectorAll<HTMLElement>("[data-issue-term]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        document.querySelector<HTMLElement>('[data-btab="terms"]')?.click();
        const term = button.dataset.issueTerm ?? "";
        const search = document.getElementById("terms-search") as HTMLInputElement | null;
        if (search) { search.value = term; search.dispatchEvent(new Event("input", { bubbles: true })); }
      });
    });
  }

  /**
   * 审校条目的「定位」。
   *
   * 从前只调 `chapterEditor?.revealParagraph()` ——而审校面板和正文编辑器**共用 #bpanel**，
   * 切到审校 tab 时编辑器已经被销毁，`chapterEditor` 为 null，`?.` 静默短路，
   * 点「定位」什么都不发生（作者实测：跳转不起作用）。
   *
   * 正确动作是两步：先切回正文编辑 tab 等编辑器挂载，再定位。挂不上就说话，不静默。
   */
  async function jumpToParagraph(paragraphId: string): Promise<void> {
    if (!chapterEditor) {
      document.querySelector<HTMLElement>('[data-btab="bi"]')?.click();
      // 切 tab 会触发章节重渲（异步读盘 + 建编辑器），轮询等它挂上来
      const deadline = Date.now() + 3000;
      while (!chapterEditor && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 60));
      }
    }
    if (!chapterEditor) {
      runtimeWindow.showToast?.("打不开正文编辑器，无法定位到这一段", { duration: 2800 });
      return;
    }
    if (chapterEditor.revealParagraph(paragraphId) === false) {
      runtimeWindow.showToast?.("这一段已经不在译文里了（可能被改过）", { duration: 2600 });
    }
  }

  /**
   * 「完成本章」——纯记账，不锁定。只对 stuck 出现：状态机里只有 stuck 能直达 approved
   * （`translated → approved` 是被禁止的转移），对别的状态摆一个按钮就是在索要做不到的操作。
   */
  async function finishChapter(workspaceId: string, chapterId: string): Promise<void> {
    const api = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<{ ok: boolean; error?: { message?: string } }> } }).lightee;
    const result = await api?.invoke("chapter.accept", { workspaceId, chapterId });
    if (!result?.ok) {
      runtimeWindow.showToast?.(result?.error?.message ?? "标记完成失败", { duration: 3200 });
      return;
    }
    runtimeWindow.pushEvent?.(`已把 ${chapterId} 标记为完成`, "ok");
    await renderReviewPanel(workspaceId);
  }

  async function renderReviewPanel(workspaceId: string): Promise<void> {
    // 竞态防护：仅当 review tab 激活时才写 bpanel
    if (document.querySelector("[data-btab].on")?.getAttribute("data-btab") !== "review") return;
    const panel = document.getElementById("bpanel");
    if (!panel) return;
    const chapterTitle = activeChapterContent?.chapterId ?? "未打开章节";
    const state = activeChapterState();
    const chapterId = activeChapterContent?.chapterId;
    const current = lastReview?.chapterId === chapterId ? lastReview : null;
    const noTranslation = current?.view.noTranslation === true;
    const lastAt = current?.at ?? 0;
    const sinceNote = lastAt ? `上次检查 ${Math.max(1, Math.round((Date.now() - lastAt) / 60000))} 分钟内` : "";
    const finishButton = state === "stuck" ? `<button class="tw-btn" id="review-finish">完成本章</button>` : "";
    const disabledAttr = noTranslation ? ' disabled title="本章还没有译文"' : "";
    panel.innerHTML = `<div class="review-real">
      <div class="review-real-head">
        <div class="review-real-title"><h2>审校</h2><p>${escapeHtml(chapterTitle)} · ${escapeHtml(chapterApprovalText(state))}</p></div>
        <div class="review-real-actions">
          <button class="tw-btn primary" id="review-start"${disabledAttr}>重新检查</button>
          ${finishButton}
        </div>
      </div>
      <!-- 范围先说清楚（作者实测：点了审校直接蹦出条目，不知道它到底查了什么）。
           本章审校是**确定性的结构扫描**，一次 LLM 调用都不发；翻译好不好是另一回事，
           归「全书 AI 审校」。不写明这条，作者会把「没问题」误读成「译得没问题」。 -->
      <div class="rv-scope">
        <b>提供的审校功能有：</b>
        <ul class="rv-scope-list">${CHAPTER_SCAN_SCOPE.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        <span>以上均为本地比对，不调用 AI。实测 LLM 审校消耗巨量 token 而效果不佳，暂不提供 (￣ー￣)</span>
      </div>
      ${sinceNote ? `<div class="rv-since">${escapeHtml(sinceNote)}</div>` : ""}
      <!-- 信息层级：本章问题是打开这个 tab 的主诉求，排最上；改名复查次之；
           全书通读是可选动作（按钮文案自己写着「可选」），排最后 -->
      <div id="review-results"><div class="review-real-empty">还没检查过这一章。</div></div>
      <div id="rename-review"></div>
      ${BOOK_AI_REVIEW_ENABLED ? `<div class="review-approval" id="review-approval" aria-live="polite"><div class="review-approval-loading">读取全书 AI 审校状态…</div></div>` : ""}
    </div>`;
    document.getElementById("review-start")?.addEventListener("click", () => void runChapterReview());
    if (chapterId) document.getElementById("review-finish")?.addEventListener("click", () => void finishChapter(workspaceId, chapterId));
    renderReviewResults();
    void renderRenameReview(workspaceId);
    void updateBookReviewStatus(workspaceId);
  }

  /** 追溯改名复查队列的原因文案（EX-06）。说清「为什么这一处没自动改」，不然作者只看到一堆条目。 */
  const RENAME_REASON_TEXT: Record<string, string> = {
    too_short: "旧译名只有一个字，自动替换必然误伤别的词",
    substring_of_term: "旧译名是另一个术语译法的一部分，自动替换会连它一起改",
    human_edited: "这一段是你亲手改过的，自动通道不碰",
    overlaps_term: "这一处和另一个术语的译法咬在一起，谁该改说不清",
    no_paragraphs: "这一章没有段落记录（早期数据），无法逐段判断",
  };

  /**
   * 追溯改名的复查队列（EX-06）。
   *
   * 队列为空时整块不渲染——没有待办就不该占版面。窄门外的位置必须能看见：
   * 作者不知道有这些地方没改，旧译名就会一直留在正文里。
   */
  async function renderRenameReview(workspaceId: string): Promise<void> {
    const host = document.getElementById("rename-review");
    if (!host) return;
    const api = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<{ ok: boolean; value?: RenameReviewView }> } }).lightee;
    const result = await api?.invoke("rename.review", { workspaceId });
    if (!result?.ok || !result.value) { host.innerHTML = ""; return; }
    const view: RenameReviewView = result.value;
    const pending = view.entries.filter((entry) => !entry.resolvedAt);
    if (pending.length === 0) { host.innerHTML = ""; return; }
    host.innerHTML = `<section class="rv-rename">
      <div class="rv-rename-head"><strong>改名待复查</strong><small>${pending.length} 处</small></div>
      <div class="rv-rename-note">这些位置没有自动替换，需要你确认后手动改。</div>
      ${pending.map((entry) => `<div class="rv-rename-item" data-entry="${escapeHtml(entry.id)}">
        <div class="rv-rename-where">${escapeHtml(entry.chapterId)}${entry.paragraphId === "*" ? " · 整章" : ` · ${escapeHtml(entry.paragraphId)}`}</div>
        <div class="rv-rename-change">${escapeHtml(entry.oldZh)} → ${escapeHtml(entry.newZh)}</div>
        <div class="rv-rename-why">${escapeHtml(RENAME_REASON_TEXT[entry.reason] ?? entry.reason)}</div>
        <div class="rv-rename-excerpt">${escapeHtml(entry.excerpt)}</div>
        <button class="tw-btn" type="button" data-rename-resolve="${escapeHtml(entry.id)}">已处理</button>
      </div>`).join("")}
    </section>`;
    host.querySelectorAll<HTMLElement>("[data-rename-resolve]").forEach((button) => {
      button.addEventListener("click", async () => {
        const entryId = button.getAttribute("data-rename-resolve");
        if (!entryId) return;
        (button as HTMLButtonElement).disabled = true;
        await api?.invoke("rename.resolve", { workspaceId, entryId });
        await renderRenameReview(workspaceId);
      });
    });
  }

  async function runChapterReview(): Promise<void> {
    if (!activeWorkspace || !activeChapterContent) {
      runtimeWindow.showToast?.("请先打开要审校的章节", { duration: 2600 });
      return;
    }
    const token = workbenchContext.capture("tab", "chapter-review");
    const workspaceId = activeWorkspace.id;
    const chapterId = activeChapterContent.chapterId;
    const btn = document.getElementById("review-start");
    const results = document.getElementById("review-results");
    if (btn) { btn.textContent = "检查中…"; (btn as HTMLButtonElement).disabled = true; }
    if (results) results.innerHTML = `<div class="review-real-empty">正在检查这一章…</div>`;
    busyStart("reviewer", BUSY_LABELS.reviewer!);
    const api = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<{ ok: boolean; value?: ReviewRunView; error?: { message?: string } }> } }).lightee;
    const result = await api?.invoke("review.run", { workspaceId, chapterId }).finally(() => busyStop("reviewer"));
    if (!workbenchContext.accepts(token)) return;
    if (btn) { btn.textContent = "重新检查"; (btn as HTMLButtonElement).disabled = false; }
    if (!result?.ok || !result.value) {
      const message = result?.error?.message ?? "检查失败";
      if (results) results.innerHTML = `<div class="review-real-empty" style="color:var(--red)">检查失败：${escapeHtml(message)}</div>`;
      runtimeWindow.pushEvent?.(message, "err");
      return;
    }
    lastReview = { chapterId, view: result.value, at: Date.now() };
    const issues = result.value.issues ?? [];
    // 就地标注是主视图：问题标在作者眼睛所在的地方。
    chapterEditor?.setIssueMarks(result.value.noTranslation ? {} : issueMarksFrom(issues));
    renderReviewResults();
    runtimeWindow.pushEvent?.(
      result.value.noTranslation ? "本章还没有可审校的译文" : `检查完成：${issues.length} 个问题`,
      result.value.noTranslation ? "act" : issues.length ? "act" : "ok",
    );
  }

  // ===== Agent 控制台：真实 LLM 调用日志（完整 prompt/response，debug 质量用） =====
  //
  // 键必须是**运行时真正发出的 scope 前缀**（NM-01）。此前这里写的是
  // orchestrator/translator/reviewer/terminologist 之类的角色名，而运行时发的是
  // `translate:ch001` / `review:ch001` / `manager:ch001` / `book-review` / `probe`
  // ——两个集合**零交集**，于是控制台一直在给作者看裸 scope 串，配色也全落默认档。
  // 由 tests/invariants 的 INV-7 钉死：键集必须覆盖全部运行时前缀。
  const AGENT_LABELS: Record<string, string> = {
    translate: "译者",
    review: "章节审校",
    "book-review": "全文审校",
    "book-review:l2-shard": "全文审校·窗口",
    "book-review:reduce": "全文审校·汇总",
    // manager 已删：那次「下一步做什么」的 LLM 调用不改变任何处置路径
    //（见 orchestrator.ts 的同名注释），删掉之后没有任何地方再发这个标签。
    probe: "能力探测",
  };
  /**
   * 标签是 `前缀:章节id` 形态。先试整串（`book-review:reduce` 这类要精确命中），
   * 再退到冒号前的前缀；都不中才显示原串。
   */
  function agentLabel(label?: string): string {
    if (!label) return "LLM 调用";
    const exact = AGENT_LABELS[label];
    if (exact) return exact;
    const prefix = label.split(":")[0]!;
    const mapped = AGENT_LABELS[prefix];
    if (!mapped) return label;
    const rest = label.slice(prefix.length + 1);
    return rest ? `${mapped}·${rest}` : mapped;
  }
  type AgentLogEntry = { id: string; label?: string; model: string; thinking?: string; ok: boolean; promptPreview: string; responsePreview: string; ms: number; ts: number; error?: string; usage?: LlmUsageSnapshot; toolCallCount?: number };
  /**
   * 一次调用的完整明细。
   *
   * `tools` / `toolCalls` 是控制台此前的盲区：KA-5 之后术语登记的指令**一个字都不在
   * `prompt` 里**（判据在工具 description、形状由 schema 保证），而工具轮的产出也不在
   * `response` 里（那一轮 `response` 是空串）。只显示 prompt + response，
   * 界面上呈现的就是「我们什么都没告诉模型，模型也什么都没产出」——两句都是假的。
   */
  type AgentLogDetail = {
    prompt?: string; response?: string; reasoning?: string;
    tools?: Array<{ name: string; description?: string; parameters?: unknown }>;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  };

  /** 工具定义（发出去的那一半）渲染成可读文本。schema 用缩进 JSON，description 原样。 */
  function toolsText(tools: AgentLogDetail["tools"]): string {
    if (!tools || tools.length === 0) return "（本次调用没有带工具）";
    return tools.map((t) => [
      `▸ ${t.name}`,
      "",
      "description：",
      t.description ?? "（无）",
      "",
      "parameters（JSON Schema）：",
      JSON.stringify(t.parameters ?? {}, null, 2),
    ].join("\n")).join("\n\n──────────\n\n");
  }

  /** 工具调用（模型回来的那一半）渲染成可读文本。 */
  function toolCallsText(calls: AgentLogDetail["toolCalls"]): string {
    if (!calls || calls.length === 0) return "（本次尝试没有工具调用）";
    return calls.map((c) => `▸ ${c.name}\n\n${JSON.stringify(c.arguments, null, 2)}`).join("\n\n──────────\n\n");
  }

  /** Agent 节点类型（v2 时间线配色）。判据同 agentLabel：按 scope 前缀，不按整串 */
  function agentNodeType(label?: string): string {
    const prefix = (label ?? "").split(":")[0]!;
    if (prefix === "manager") return "manager";
    if (prefix === "translate") return "translator";
    if (prefix === "review" || prefix === "book-review") return "reviewer";
    return "compiler";
  }

  /**
   * 结果视图可读摘要。
   *
   * 从前这里有一整段解析 Orchestrator/Manager 决策 JSON 的分支（keep / revise_passages /
   * retranslate_chapter / reroute_translator）。MG-01 删掉 Manager、RV-03 退役整章重译
   * 与备用模型重译之后，`orchestrator` 与 `manager` 这两个标签**再也不会出现**
   * （两者都不发 LLM 调用了），那段分支随之删除。
   *
   * 工具轮单列一支：它的 `responsePreview` 是空串，落到原来的兜底会显示成
   * 「(空响应)」——而它其实产出了一整份工具参数。那句话是假的。
   *
   * 措辞（作者实测反馈）：「工具轮 — 只发工具调用，没有正文」三个术语叠在一起，
   * 读起来像出了故障，配上旁边空的「API 返回 0 字符」更像这次调用白跑了。
   * 现在直说这一轮的成果去哪了。
   */
  function summarizeEntry(entry: AgentLogEntry): string {
    if (!entry.ok) return `<span class="k">失败</span> — ${escapeHtml((entry.error ?? "调用失败").slice(0, 90))}`;
    if (!entry.responsePreview && entry.toolCallCount) {
      return `<span class="k">交稿</span> — 这一轮的译文写在工具参数里，展开下面「工具调用」看`;
    }
    const preview = entry.responsePreview || entry.promptPreview.slice(0, 120) || "(空响应)";
    return escapeHtml((preview.split("\n")[0] ?? preview).slice(0, 130));
  }

  // Agent 控制台模型/思考控制：读取 ai.providers.list，切换即写工作区配置
  function initAgentModelControls(): void {
    const workspaceId = activeWorkspace?.id;
    if (!workspaceId) return;
    const modelSel = document.getElementById("agent-model-sel") as HTMLSelectElement | null;
    if (!modelSel) return;
    const api2 = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<{ ok: boolean; value?: { providers?: Array<{ id: string; name: string; hasKey?: boolean; models: Array<{ id: string; name: string; thinkingLevelMap?: Record<string, string | null> }> }>; current?: string; currentThinking?: string; reviewThinking?: string }; error?: { message?: string } }> } }).lightee;
    void api2?.invoke("ai.providers.list", { workspaceId }).then((list: { ok?: boolean; value?: { providers?: Array<{ id: string; name: string; hasKey?: boolean; models: Array<{ id: string; name: string; thinkingLevelMap?: Record<string, string | null> }> }>; current?: string; currentThinking?: string; reviewThinking?: string }; error?: { message?: string } }) => {
      if (!list?.ok || activeWorkspace?.id !== workspaceId) return;
      const providers = list.value?.providers ?? [];
      const current = list.value?.current ?? "";
      // RH-13：Agent 控制台空闲态要显示「当前用什么模型、什么思考档」，与下拉同源
      agentIdleModel = current ? `${current} · 思考 ${list.value?.currentThinking ?? "high"}` : "";
      // 仅列举已配置（hasKey）可选模型；若全未配 key 则回退当前 provider，保证当前值可见
      const configuredProviders = providers.filter((provider) => provider.hasKey);
      const candidates = configuredProviders.length > 0 ? configuredProviders : providers;
      const flat: Array<{ value: string; label: string; tlm?: Record<string, string | null> }> = [];
      const seen = new Set<string>();
      for (const provider of candidates) {
        for (const model of provider.models ?? []) {
          const value = `${provider.id}/${model.id}`;
          if (seen.has(value)) continue;
          seen.add(value);
          flat.push({ value, label: model.name || model.id, tlm: model.thinkingLevelMap });
        }
      }
      // 当前 provider 未配 key 但也可能被选中 → 补进列表（避免当前值不可见）
      if (current && !seen.has(current)) {
        const owner = providers.find((provider) => current.startsWith(`${provider.id}/`));
        if (owner) {
          for (const model of owner.models ?? []) {
            const value = `${owner.id}/${model.id}`;
            if (seen.has(value)) continue;
            seen.add(value);
            flat.push({ value, label: model.name || model.id, tlm: model.thinkingLevelMap });
          }
        }
      }
      modelSel.innerHTML = flat.map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`).join("");
      if (current && flat.some((item) => item.value === current)) modelSel.value = current;
      const activeModel = flat.find((item) => item.value === current);
      const tSel = document.getElementById("agent-thinking-sel") as HTMLSelectElement | null;
      if (tSel) {
        // 与运行时同一套语义：未探测的档位照样可选，但标出来它没有依据（shared/thinking-levels.ts）
        const levels = supportedThinkingLevels(activeModel?.tlm);
        tSel.innerHTML = levels.length
          ? levels.map((level) => `<option value="${level.id}">${level.label}${level.proven ? "" : "（未探测）"}</option>`).join("")
          : `<option value="">不支持思考</option>`;
        tSel.disabled = levels.length === 0;
        const cur = list.value?.currentThinking ?? "high";
        tSel.value = levels.some((level) => level.id === cur) ? cur : (levels[0]?.id ?? "off");
        tSel.onchange = () => {
          void api2?.invoke("ai.thinking.write", { workspaceId, thinking: tSel.value }).then((r: { ok?: boolean; error?: { message?: string } }) => {
            runtimeWindow.pushEvent?.(r?.ok ? `思考档位：${tSel.value}` : "思考档位保存失败", r?.ok ? "ok" : "err");
          });
        };
      }
      modelSel.onchange = () => {
        const value = modelSel.value;
        if (!value) return;
        void writeActiveModel(workspaceId, value).then((written) => {
          runtimeWindow.pushEvent?.(written.ok ? `模型：${value}` : `模型保存失败${written.message ? `：${written.message}` : ""}`, written.ok ? "ok" : "err");
        });
      };
      // 「（未探测）」的出口就近给：不用去设置页找模型行，当前模型在这里就能标定
      const probeBtn = document.getElementById("agent-probe-btn") as HTMLButtonElement | null;
      if (probeBtn) {
        const target = modelSel.value || current;
        const owner = providers.find((provider) => target.startsWith(`${provider.id}/`));
        probeBtn.hidden = !owner;
        probeBtn.onclick = () => {
          const picked = modelSel.value || current;
          const ownerNow = providers.find((provider) => picked.startsWith(`${provider.id}/`));
          if (!ownerNow) return;
          const modelId = picked.slice(ownerNow.id.length + 1);
          probeBtn.disabled = true;
          probeBtn.textContent = "探测中…";
          runtimeWindow.pushEvent?.(`正在逐档试探 ${picked}（每档一次极小请求）…`, "ok");
          void api2?.invoke("ai.thinking.probe", { providerId: ownerNow.id, modelId }).then((r: { ok?: boolean; value?: unknown; error?: { message?: string } }) => {
            probeBtn.disabled = false;
            probeBtn.textContent = "探测";
            if (!r?.ok) { runtimeWindow.pushEvent?.(`探测失败：${r?.error?.message ?? ""}`, "err"); return; }
            const outcomes = (r.value as unknown as { outcomes?: Array<{ accepted: boolean }> })?.outcomes ?? [];
            runtimeWindow.pushEvent?.(`${modelId} 探测完成：${outcomes.filter((o) => o.accepted).length}/${outcomes.length} 档被接受`, "ok");
            initAgentModelControls(); // 重新拉列表——「（未探测）」标记随实测结果消失
          });
        };
      }
    });
  }

  /** Agent 控制台空闲态展示的「当前模型 · 思考档」，由模型下拉刷新时同步 */
  let agentIdleModel = "";

  /**
   * 用量去向（TR-10）。展示逻辑在 `usage-view.ts`（纯函数、可单测），这里只画。
   *
   * 页脚那四个聚合数字回答不了「钱花在哪」：看到「输出 81166」既不知道是哪一章
   * 吃掉的，也不知道其中多少是思考、多少废在没交付结果的尝试上——而 2026-08-12
   * 的一次跑批里，89634 输出 token 中有 65535 就废在四次没吐出正文的尝试上。
   *
   * 口径与命令行跑批共用同一份 buildUsageReport / groupUsageByLabel。
   */
  async function renderUsagePanel(panel: HTMLElement, workspaceId: string): Promise<void> {
    const box = panel.querySelector<HTMLElement>(".agent-usage");
    if (!box) return;
    const api = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<{ ok: boolean; value?: { report?: UsageReportInput; groups?: UsageGroupInput[] } }> } }).lightee;
    const result = await api?.invoke("usage.report", { workspaceId });
    if (!result?.ok || !result.value?.report) { box.hidden = true; return; }
    const view = describeUsage({ report: result.value.report, groups: result.value.groups ?? [] });
    box.hidden = false;
    if (view.empty) {
      box.innerHTML = `<div class="agent-usage-head">用量去向</div><div class="agent-usage-empty">本工作区还没有调用记录。</div>`;
      return;
    }
    // 行数按章增长（203 话的书就有 203 行）。从前靠 max-height + overflow 收着，
    // 结果是一个两三行高的小框里挂着一条迷你滚动条——既看不全也难滚。
    // 改为只列最近几条，剩下多少如实写出来（不做无声截断）。
    const VISIBLE_USAGE_ROWS = 4;
    const shown = view.rows.slice(0, VISIBLE_USAGE_ROWS);
    const hidden = view.rows.length - shown.length;
    box.innerHTML = `<div class="agent-usage-head">用量去向<span class="agent-usage-total">${escapeHtml(view.total)}</span></div>
      <div class="agent-usage-rows">${shown.map((r) => `<div class="au-row ${r.tone}">
        <b title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</b>
        <span>${escapeHtml(r.attemptsText)}</span>
        <span>${escapeHtml(r.outputText)}</span>
        <span>${escapeHtml(r.reasoningText)}</span>
        <span class="au-note">${escapeHtml(r.noteText)}</span>
      </div>`).join("")}${hidden > 0 ? `<div class="au-more">另有 ${hidden} 项未列出，合计已计入上方总量</div>` : ""}</div>
      ${view.findings.length > 0 ? `<div class="agent-usage-findings">${view.findings.map((f) => `<div>• ${escapeHtml(f)}</div>`).join("")}</div>` : ""}`;
  }

  // ===== 轨迹带（UI-9，结构借鉴 deepseek-harness 的 trajectory 查看器；配色走本应用调色板）=====
  /** 布局模式（其 Duration 开关）：真实时长 / 等宽 */
  let traceMode: TraceLayoutMode = "actual";
  /** 搜索词（空格分词、全部命中；不命中的行隐藏、色块压暗） */
  let traceQuery = "";

  function traceHaystack(entry: AgentLogEntry): string {
    return [entry.label ? AGENT_LABELS[entry.label] ?? entry.label : "", entry.model, entry.thinking ?? "", entry.promptPreview, entry.responsePreview, entry.error ?? ""].join(" ");
  }

  function applyTraceFilter(panel: HTMLElement, entries: AgentLogEntry[]): void {
    const matched = new Set(entries.filter((entry) => traceSearchMatch(traceHaystack(entry), traceQuery)).map((entry) => entry.id));
    panel.querySelectorAll<HTMLElement>(".agent-node[data-id]").forEach((node) => {
      node.hidden = !matched.has(node.dataset.id ?? "");
    });
    panel.querySelectorAll<HTMLElement>(".atb-seg[data-trace-jump]").forEach((seg) => {
      seg.classList.toggle("dim", !matched.has(seg.dataset.traceJump ?? ""));
    });
  }

  function renderTraceBand(panel: HTMLElement, entries: AgentLogEntry[], totals: LlmUsageSnapshot | undefined): void {
    const traceBox = panel.querySelector<HTMLElement>("#agent-trace");
    if (!traceBox) return;
    const segments = traceTimeline(entries, traceMode);
    traceBox.hidden = segments.length === 0;
    if (segments.length === 0) return;
    const byLane: Record<0 | 1, string[]> = { 0: [], 1: [] };
    // 不挂 title：鼠标划过轨迹带就弹一串黑框，色块又密又小，等于一路弹个不停（作者裁定 2026-08-13）。
    // 点击跳到对应条目仍然可用，那里什么都写得清楚。
    for (const segment of segments) {
      byLane[segment.lane].push(`<span class="atb-seg ${segment.kind}" role="listitem" data-trace-jump="${escapeHtml(segment.id)}" style="left:${segment.leftPct}%;width:${segment.widthPct}%"></span>`);
    }
    traceBox.querySelectorAll<HTMLElement>(".atb-track").forEach((track) => {
      track.innerHTML = byLane[track.dataset.lane === "1" ? 1 : 0].join("");
    });
    traceBox.querySelectorAll<HTMLElement>("[data-trace-jump]").forEach((seg) => {
      seg.onclick = () => {
        const node = panel.querySelector<HTMLElement>(`.agent-node[data-id="${CSS.escape(seg.dataset.traceJump ?? "")}"]`);
        if (!node) return;
        node.scrollIntoView({ behavior: "smooth", block: "center" });
        node.classList.add("trace-flash");
        window.setTimeout(() => node.classList.remove("trace-flash"), 1200);
      };
    });
    const stats = traceBox.querySelector<HTMLElement>("#agent-trace-stats");
    if (stats) stats.textContent = traceStats(entries, totals);
    const modeBtn = traceBox.querySelector<HTMLButtonElement>("#agent-trace-mode");
    if (modeBtn) {
      modeBtn.textContent = traceMode === "actual" ? "真实时长" : "等宽";
      modeBtn.onclick = () => {
        traceMode = traceMode === "actual" ? "equal" : "actual";
        renderTraceBand(panel, entries, totals);
      };
    }
    const search = traceBox.querySelector<HTMLInputElement>("#agent-trace-search");
    if (search) {
      if (search.value !== traceQuery) search.value = traceQuery;
      search.oninput = () => {
        traceQuery = search.value;
        applyTraceFilter(panel, entries);
      };
    }
    if (traceQuery) applyTraceFilter(panel, entries);
  }

  async function renderAgentConsole(): Promise<void> {
    // 仅当同一工作区的 Agent tab 激活时才写入 bpanel。
    if (activeBtab() !== "agent") return;
    const token = workbenchContext.capture("tab", "agent-console");
    const panel = document.getElementById("bpanel");
    if (!panel) return;
    const api = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<{ ok: boolean; value?: { entries?: AgentLogEntry[]; totals?: LlmUsageSnapshot }; error?: { message?: string } }> } }).lightee;
    // 只列当前这本书的调用（按调用记录里的工作区戳过滤）。没有戳的旧记录无法归属，
    // 不出现在任何书的控制台里——控制台是按书看的，不是全局流水账。
    // 没有工作区就不渲染：回落成全局查询会把所有书的记录当成这本书的展示出来。
    if (!activeWorkspace) return;
    const result = await api?.invoke("agent.log.list", { limit: 60, workspaceId: activeWorkspace.id });
    const entries: AgentLogEntry[] = result?.ok ? (result.value?.entries ?? []) : [];
    const totals = result?.ok ? result.value?.totals : undefined;
    if (!workbenchContext.accepts(token) || activeBtab() !== "agent") return;
    // 首次渲染：面板骨架（时间线 + Debug 开关 + 图例）
    if (!panel.querySelector(".agent-panel")) {
      panel.innerHTML = `<div class="agent-panel">
        <div class="agent-console-head">
          <h2 class="agent-console-title">Agent 控制台</h2>
          <!-- 从前这里是「模型 + 一个折叠面板，里面装三个思考档位」。三档的模型已经
               不成立了：术语档没有任何消费者（ADR-0007 把提取并进翻译请求），审校档
               的唯一消费者是全书审校，而那条功能的入口是关的（BOOK_AI_REVIEW_ENABLED）。
               只剩翻译一档时，折叠面板就是多一次点击才够得到一个下拉——两件都摊平放。 -->
          <div class="agent-model-pick">
            <label class="amp-item" title="翻译使用的模型（写入工作区配置；确定模型不会被自动更改）"><span class="amp-key">模型</span><select id="agent-model-sel"></select></label>
            <span class="amp-sep" aria-hidden="true"></span>
            <label class="amp-item" title="翻译与自动修订的思考强度。术语登记在翻译的同一次请求里完成，用的也是这一档"><span class="amp-key">思考</span><select id="agent-thinking-sel"></select></label>
            <button type="button" class="amp-probe" id="agent-probe-btn" title="逐档给当前模型发一次极小请求，按服务商实际接受情况标定思考档位——标定后「（未探测）」会消失">标定</button>
          </div>
          <label class="debug-switch" data-debug-toggle title="切换简略或完整视图"><input type="checkbox" class="debug-check" aria-label="完整视图"/><span class="switch" aria-hidden="true"><span class="knob"></span></span><span class="lbl" data-mode-label>简略</span></label>
        </div>
        <div class="agent-composer" id="agent-composer"></div>
        <div class="agent-live" hidden></div>
        <div class="agent-usage" hidden></div>
        <div class="agent-trace" id="agent-trace" hidden>
          <div class="agent-trace-bar">
            <button type="button" class="atb-mode" id="agent-trace-mode">真实时长</button>
            <input type="search" class="atb-search" id="agent-trace-search" placeholder="搜索调用（空格分词）" aria-label="搜索调用" />
          </div>
          <div class="agent-trace-band" id="agent-trace-band" aria-label="调用时间线">
            <div class="atb-row"><span class="atb-lab">模型</span><div class="atb-track" data-lane="0" role="list"></div></div>
            <div class="atb-row"><span class="atb-lab">工具</span><div class="atb-track" data-lane="1" role="list"></div></div>
          </div>
          <div class="agent-trace-stats" id="agent-trace-stats"></div>
        </div>
        <div class="agent-timeline"></div>
        <div class="agent-foot"><span>输入 token</span><b id="agent-tok-in">${totals?.input ?? 0}</b><span>输出 token</span><b id="agent-tok-out">${totals?.output ?? 0}</b><span>缓存读</span><b id="agent-tok-cread">${totals?.cacheRead ?? 0}</b><span>缓存写</span><b id="agent-tok-cwrite">${totals?.cacheWrite ?? 0}</b><span title="${escapeHtml(CACHE_RATE_TITLE)}">命中率</span><b id="agent-cache-rate" title="${escapeHtml(CACHE_RATE_TITLE)}">${formatHitRate(totals)}</b><span class="agent-foot-note" style="margin-left:auto;opacity:.75">${escapeHtml(CACHE_RATE_NOTE)}</span></div>
      </div>`;
      // 面板被重建（如 tab 切换覆盖后）→ 重置签名，强制重渲时间线
      (window as BridgeWindow & { __agentTimelineSig?: string }).__agentTimelineSig = "";
      const check = panel.querySelector<HTMLInputElement>(".debug-check");
      const applyMode = (): void => {
        const complete = check?.checked ?? false;
        panel.querySelector(".agent-panel")?.classList.toggle("debug", complete);
        const label = panel.querySelector("[data-mode-label]");
        if (label) label.textContent = complete ? "完整" : "简略";
      };
      // label + checkbox 的原生行为负责切换；再监听 click 手工反转会造成一次点击翻转两次。
      check?.addEventListener("change", applyMode);
      // 浮层要能被「点别处」关掉：<details> 原生只认 summary 的点击，
      // 留一个点不掉的浮层压在时间线上，比不做折叠更糟。
      const think = panel.querySelector<HTMLDetailsElement>("#agent-think-disclosure");
      if (think) {
        document.addEventListener("pointerdown", (event) => {
          if (!think.open || !think.isConnected) return;
          if (!think.contains(event.target as Node)) think.open = false;
        });
        think.addEventListener("keydown", (event) => {
          if ((event as KeyboardEvent).key === "Escape") { think.open = false; think.querySelector("summary")?.focus(); }
        });
      }
      initAgentModelControls();
      const composerBox = panel.querySelector<HTMLElement>("#agent-composer");
      if (composerBox) bindComposer(composerBox);
    }
    // 命令栏每轮重画：勾选摘要与跑批进度都是活的
    renderComposer();
    // 用量去向每轮重画。与页脚同理：只在骨架里建一次就等于一张不会更新的表。
    if (activeWorkspace) void renderUsagePanel(panel, activeWorkspace.id);
    // 页脚每轮都要重写：骨架只建一次，此前这几个 id 从骨架落地后就再没人碰过，
    // 于是 token 数停在打开面板那一刻——一个不会更新的用量表比没有更坏。
    const setFoot = (id: string, text: string): void => {
      const el = panel.querySelector<HTMLElement>(`#${id}`);
      if (el) el.textContent = text;
    };
    setFoot("agent-tok-in", String(totals?.input ?? 0));
    setFoot("agent-tok-out", String(totals?.output ?? 0));
    setFoot("agent-tok-cread", String(totals?.cacheRead ?? 0));
    setFoot("agent-tok-cwrite", String(totals?.cacheWrite ?? 0));
    setFoot("agent-cache-rate", formatHitRate(totals));
    renderTraceBand(panel, entries, totals);
    // 空闲时不展示状态；只保留正在运行或失败的活动提示。
    const liveEl = panel.querySelector<HTMLElement>(".agent-live");
    if (liveEl) {
      const order = ["orchestrator", "terminologist", "translator", "reviewer", "bookreview"];
      const active = order.flatMap((agent) => {
        const state = agentStates[agent];
        if (!state || (state.status !== "running" && state.status !== "failed")) return [];
        return [{ agent, state }];
      });
      liveEl.hidden = active.length === 0;
      liveEl.innerHTML = active.map(({ agent, state }) => {
        const label = agent === "bookreview" ? "全文审校" : agentLabel(agent);
        const statusClass = state.status === "failed" ? "failed" : "running";
        return `<div class="agent-live-row ${statusClass}"><span class="as-dot"></span><b>${escapeHtml(label)}</b>${state.message ? `<span>${escapeHtml(state.message)}</span>` : ""}</div>`;
      }).join("");
    }
    // 时间线：id 签名去重 → 保持展开与滚动位置
    const tl = panel.querySelector(".agent-timeline");
    if (!tl) return;
    const prevSig = (window as BridgeWindow & { __agentTimelineSig?: string }).__agentTimelineSig;
    const newSig = entries.map((e) => e.id).join("|");
    if (prevSig === newSig) return;
    (window as BridgeWindow & { __agentTimelineSig?: string }).__agentTimelineSig = newSig;
    const openIds = new Set([...tl.querySelectorAll<HTMLElement>(".call.open")].map((el) => el.closest(".agent-node")?.getAttribute("data-id") ?? ""));
    const prevScroll = tl.scrollTop;
    tl.innerHTML = entries.length === 0
      // RH-13：空白面板不解释自己。这里说清「现在用什么模型」和「什么时候会有内容」，
      // 否则用户看到一片空只会怀疑功能坏了（wiki §9.3 登记的欠账）。
      ? `<div class="agent-console-empty">
           <strong>还没有 LLM 调用记录</strong>
           <span>当前：${escapeHtml(agentIdleModel || "未配置模型")}</span>
           <span>运行翻译或审校时，这里会实时显示每次调用的完整输入与输出。</span>
         </div>`
      : entries.map((entry) => {
        const type = agentNodeType(entry.label);
        const time = new Date(entry.ts).toLocaleTimeString("zh-CN", { hour12: false });
        const ms = entry.ms;
        const msText = ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms";
        const act = entry.label ? (AGENT_LABELS[entry.label] ?? entry.label) : "LLM 调用";
        const summary = summarizeEntry(entry);
        const errKind = !entry.ok ? (/quota|余额/i.test(entry.error ?? "") ? "quota" : /auth|密钥|401/i.test(entry.error ?? "") ? "auth" : "错误") : "";
        // 逐条缓存读/写：全书前缀有没有被打穿，只有单次调用的读数说得清。
        const cacheText = formatCallCache(entry.usage);
        return `<div class="agent-node ${entry.ok ? "" : "err"}" data-a="${type}" data-id="${escapeHtml(entry.id)}">
          <div class="stamp">${time}<span class="sec">+${msText}</span></div>
          <div class="pulse"></div>
          <div class="call ${entry.ok ? "" : "err"}">
            <div class="top" data-ag-toggle role="button" tabindex="0">
              <span class="grip"></span>
              <div class="who"><span class="name">${escapeHtml(act)}</span></div>
              <div class="result">${summary}</div>
              <div class="meta">
                ${entry.toolCallCount ? `<span class="pill tool" title="模型这一轮用工具交稿：成果在下面「工具调用」里，不在「API 返回」——所以那一栏是空的，不是调用失败">工具 ×${entry.toolCallCount}</span>` : ""}
                ${entry.thinking ? `<span class="pill thinking">${escapeHtml(entry.thinking)}</span>` : ""}
                ${cacheText ? `<span class="pill cache" title="${escapeHtml(`${CALL_CACHE_TITLE}${CACHE_RATE_NOTE}`)}">${escapeHtml(cacheText)}</span>` : ""}
                <span class="pill time">${msText}</span>
                ${entry.ok ? "" : `<span class="pill kind">${escapeHtml(errKind)}</span>`}
              </div>
            </div>
            <div class="body">
              ${entry.ok ? "" : `<div class="sec open" data-k="err"><div class="sec-head"><span class="chev"></span>错误 <span class="tag">${escapeHtml(errKind)}</span></div><div class="sec-body"><div class="errbox"><div class="t">调用失败</div><div class="m">${escapeHtml(entry.error ?? "")}</div><div class="h">→ 请到「AI 设置」检查密钥 / 配额后重试。</div></div></div></div>`}
              <!-- 默认展开哪一栏 = 这一条的成果在哪：
                   用工具交稿的那一轮，「API 返回」本来就是空的（成果在工具参数里），
                   默认摊开一个空框只会让人以为调用失败；此时改为默认展开「工具调用」。
                   「输入 prompt」一律默认收起——它是整条里最长的一块，摊开会把下面的
                   内容全挤出视野（作者实测：控制台一进去就被它占满）。 -->
              <div class="sec${entry.ok && !entry.responsePreview && entry.toolCallCount ? "" : " open"}" data-k="out"><div class="sec-head" data-ag-sec><span class="chev"></span>API 返回 <span class="tag">raw</span><span class="count">${entry.ok ? String(entry.responsePreview.length) : "—"} 字符</span></div><div class="sec-body"><pre class="code" data-full="out">${escapeHtml(entry.ok ? (entry.responsePreview || (entry.toolCallCount ? "（这一轮用工具交稿，正文通道本来就没有内容——成果在上面「工具调用」里）" : "")) : "(失败，无返回)")}</pre></div></div>
              <div class="sec${entry.ok && !entry.responsePreview && entry.toolCallCount ? " open" : ""}" data-k="calls"><div class="sec-head" data-ag-sec><span class="chev"></span>工具调用 <span class="tag">模型产出</span></div><div class="sec-body"><pre class="code" data-full="calls">（展开后加载）</pre></div></div>
              <div class="sec inf" data-k="in"><div class="sec-head" data-ag-sec><span class="chev"></span>输入 prompt <span class="tag">system+user</span><span class="foldbtn" data-ag-fold>展开</span></div><div class="sec-body"><pre class="code" data-full="in">${escapeHtml(entry.promptPreview)}</pre></div></div>
              <div class="sec" data-k="tools"><div class="sec-head" data-ag-sec><span class="chev"></span>工具定义 <span class="tag">发出去的指令</span></div><div class="sec-body"><pre class="code" data-full="tools">（展开后加载）</pre></div></div>
              <div class="sec" data-k="think"><div class="sec-head" data-ag-sec><span class="chev"></span>思考 <span class="tag">reasoning</span></div><div class="sec-body"><pre class="code clamp" data-full="think">（展开后加载完整 reasoning）</pre><span class="morebtn" data-ag-more>显示全部</span></div></div>
            </div>
          </div>
        </div>`;
      }).join("");
    tl.scrollTop = prevScroll;
    // 加载完整 prompt/response/reasoning（agent.log.read 无条件可用）
    const loadFull = (node: HTMLElement): void => {
      const id = node.getAttribute("data-id") ?? "";
      void api?.invoke("agent.log.read", { id }).then((r2: { ok?: boolean; value?: AgentLogDetail } | undefined) => {
        const v = r2?.ok ? r2.value : undefined;
        if (!v) return;
        const fill = (k: string, text: string): void => {
          const pre = node.querySelector(`[data-full="${k}"]`);
          if (pre) pre.textContent = text;
        };
        if (v.prompt !== undefined) fill("in", v.prompt);
        if (v.response !== undefined) fill("out", v.response);
        if (v.reasoning !== undefined) fill("think", v.reasoning);
        // 工具通道的两半。**无条件填**（而不是 `if (v.tools)`）：没有工具时也要写出
        // 「本次调用没有带工具」，否则那一格永远停在「展开后加载」，看起来像加载失败。
        fill("tools", toolsText(v.tools));
        fill("calls", toolCallsText(v.toolCalls));
        const more = node.querySelector("[data-ag-more]");
        if (more) (more as HTMLElement).style.display = v.reasoning ? "inline-flex" : "none";
      });
    };
    tl.querySelectorAll("[data-ag-toggle]").forEach((top) => {
      (top as HTMLElement).addEventListener("click", () => {
        const node = (top as HTMLElement).closest(".agent-node");
        if (!node) return;
        const call = node.querySelector(".call");
        const open = call?.classList.contains("open");
        call?.classList.toggle("open", !open);
        if (!open) loadFull(node as HTMLElement);
      });
    });
    tl.querySelectorAll("[data-ag-sec]").forEach((head) => {
      (head as HTMLElement).addEventListener("click", (ev) => {
        ev.stopPropagation();
        (head as HTMLElement).closest(".sec")?.classList.toggle("open");
      });
    });
    tl.querySelectorAll("[data-ag-fold]").forEach((btn) => {
      (btn as HTMLElement).addEventListener("click", (ev) => {
        ev.stopPropagation();
        const sec = (btn as HTMLElement).closest(".sec");
        if (!sec) return;
        sec.classList.toggle("inf");
        (btn as HTMLElement).textContent = sec.classList.contains("inf") ? "展开" : "折叠";
      });
    });
    tl.querySelectorAll("[data-ag-more]").forEach((btn) => {
      (btn as HTMLElement).addEventListener("click", (ev) => {
        ev.stopPropagation();
        const pre = (btn as HTMLElement).previousElementSibling as HTMLElement | null;
        if (!pre) return;
        pre.classList.toggle("clamp");
        (btn as HTMLElement).textContent = pre.classList.contains("clamp") ? "显示全部" : "收起";
      });
    });
    // 恢复展开状态（重新加载详情）
    openIds.forEach((id) => {
      const node = Array.from(tl.querySelectorAll<HTMLElement>(".agent-node")).find((n) => n.getAttribute("data-id") === id);
      if (!node) return;
      node.querySelector(".call")?.classList.add("open");
      loadFull(node);
    });
  }

  // AI 翻译：作者显式触发；术语未确认 → 引导跳术语 tab（阶段 B 接真实确认）
  /** RH-16：取消本章进行中的翻译/审校；状态回 ready 后主按钮自动变回「开始翻译」 */
  async function cancelAiTranslate(chapterId: string): Promise<void> {
    if (!activeWorkspace) return;
    const api = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<{ ok: boolean; value?: { status?: string }; error?: { message?: string } }> } }).lightee;
    const result = await api?.invoke("translate.cancel", { workspaceId: activeWorkspace.id, chapterId });
    if (!result?.ok) {
      runtimeWindow.pushEvent?.(`取消失败：${result?.error?.message ?? "未知错误"}`, "err");
      return;
    }
    runtimeWindow.pushEvent?.(result.value?.status === "idle" ? "该章节当前没有进行中的任务" : `正在取消 ${chapterId}…`, "act");
  }

  // ===== 范围跑批（RS-2 / D4、D5、D7、D12）：命令栏 + 章节可选框 =====
  //
  // 单章直翻入口退役：所有翻译都是「一次跑批」（单章 = 勾一章的跑批）。
  // 主按钮与 demo 的 startTranslate 都改为丝滑跳 Agent 控制台并预填范围
  // （grill 决议：入口只发意图，范围在命令栏可见、可改）。stuck 的
  // 「显式发起=重置重跑」语义由主进程 translateRun 保留，勾选即触发。

  function scopeOptions(): ScopeChapterOption[] {
    return (activeWorkspace?.volumes ?? []).flatMap((volume) => volume.chapters)
      .map((chapter) => ({ chapterId: chapter.id, title: chapter.title, state: chapter.state }));
  }

  function scopeChapterTitle(chapterId?: string): string {
    if (!chapterId) return "";
    const all = activeWorkspace?.volumes.flatMap((volume) => volume.chapters) ?? [];
    return all.find((chapter) => chapter.id === chapterId)?.title ?? chapterId;
  }

  /** 当前勾选集。composerSelection=null 表示默认（未译全选）；顺带清掉已不存在的章 */
  function currentScopeSelection(options: ScopeChapterOption[]): Set<string> {
    if (!composerSelection) return defaultSelection(options);
    const valid = new Set(options.map((option) => option.chapterId));
    for (const id of [...composerSelection]) if (!valid.has(id)) composerSelection.delete(id);
    return composerSelection;
  }

  function renderComposer(): void {
    const box = document.getElementById("agent-composer");
    if (!box) return;
    if (!activeWorkspace) { box.innerHTML = ""; return; }
    const options = scopeOptions();
    const selected = currentScopeSelection(options);
    const summary = summarizeSelection(options, selected);
    const stuckUnchecked = stuckChapterIds(options).filter((id) => !selected.has(id));
    const running = scopeInvokePending || scopeRun !== null;
    const stopView = stopButtonView(scopeRun);
    const runLabel = running ? (stopView.label || "⏹ 停止") : "开始翻译";
    // 「开始翻译」不带 title：按钮名字已经说完了它做什么，旁边的范围摘要说完了对谁做。
    // 停止那侧留着——两段式停止（先停派发、再中断当前章）不解释就是猜。
    const runTitle = running ? stopView.title : "";
    // 跑批中摘要行让位给进度：范围此刻已经定格，反复展示勾选摘要没有信息量
    const summaryText = running && scopeRun
      ? `${busyScopePrefix(scopeRun)}${scopeRun.chapterId ? `正在翻译「${scopeChapterTitle(scopeRun.chapterId)}」` : "工作中"}`
      : summary.text;
    box.innerHTML = `
      <div class="ac-row">
        <span class="ac-op" title="命令栏（D12）：操作 · 范围 · 参数。本轮只有「翻译」">翻译</span>
        <button type="button" class="ac-scope" data-ac="toggle" ${running ? "disabled" : ""} aria-expanded="${composerOpen ? "true" : "false"}">范围 ${summary.count} 章<span class="ac-caret">${composerOpen ? "▴" : "▾"}</span></button>
        <span class="ac-summary">${escapeHtml(summaryText)}</span>
        <button type="button" class="ac-run ${running ? "running" : ""}" data-ac="run" ${running && stopView.disabled ? "disabled" : ""}${runTitle ? ` title="${escapeHtml(runTitle)}"` : ""}>${escapeHtml(runLabel)}</button>
      </div>
      <div class="ac-chapters" ${composerOpen && !running ? "" : "hidden"}>
        <div class="ac-tools">
          <a href="#" data-ac="default">恢复默认（未译全选）</a>
          <a href="#" data-ac="none">全不选</a>
          ${stuckUnchecked.length > 0 ? `<a href="#" data-ac="stuck" title="卡住的章节重跑会从头翻一遍">把 ${stuckUnchecked.length} 个卡住的章节也勾上</a>` : ""}
        </div>
        <div class="ac-list">${options.map((option) => {
          const disabled = isInFlightState(option.state);
          const checked = selected.has(option.chapterId) && !disabled;
          const badge = disabled ? "处理中" : option.state === "stuck" ? "卡住 · 重跑从头翻" : isDoneState(option.state) ? "已译 · 勾选会重译" : "";
          return `<label class="ac-ch ${disabled ? "off" : ""}"><input type="checkbox" data-cid="${escapeHtml(option.chapterId)}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}><span class="ac-ch-title">${escapeHtml(option.title)}</span>${badge ? `<span class="ac-ch-badge ${option.state === "stuck" ? "stuck" : ""}">${escapeHtml(badge)}</span>` : ""}</label>`;
        }).join("")}</div>
      </div>`;
  }

  /** 命令栏事件委托。骨架建好时绑一次；innerHTML 重画不掉监听 */
  function bindComposer(box: HTMLElement): void {
    box.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-ac]");
      if (!target) return;
      const action = target.dataset.ac;
      if (action === "run") { event.preventDefault(); if (scopeInvokePending || scopeRun) void stopScopeRun(); else void startScopeRun(); return; }
      if (action === "toggle") { event.preventDefault(); composerOpen = !composerOpen; renderComposer(); return; }
      const options = scopeOptions();
      const selected = new Set(currentScopeSelection(options));
      if (action === "default") composerSelection = null;
      else if (action === "none") composerSelection = new Set();
      else if (action === "stuck") { for (const id of stuckChapterIds(options)) selected.add(id); composerSelection = selected; }
      else return;
      event.preventDefault();
      renderComposer();
    });
    box.addEventListener("change", (event) => {
      const input = event.target as HTMLInputElement;
      const chapterId = input?.dataset?.cid;
      if (!chapterId) return;
      const options = scopeOptions();
      const selected = new Set(currentScopeSelection(options));
      if (input.checked) selected.add(chapterId); else selected.delete(chapterId);
      composerSelection = selected;
      renderComposer();
    });
  }

  async function startScopeRun(): Promise<void> {
    if (!activeWorkspace || scopeInvokePending || scopeRun) return;
    const options = scopeOptions();
    const summary = summarizeSelection(options, currentScopeSelection(options));
    if (summary.count === 0) { runtimeWindow.showToast?.("请先勾选要翻译的章节", { duration: 2400 }); return; }
    const workspaceId = activeWorkspace.id;
    const api = (window as BridgeWindow & { lightee?: { invoke: (command: string, payload: unknown) => Promise<{ ok: boolean; error?: { code?: string; message?: string }; value?: unknown }> } }).lightee;
    if (!api?.invoke) return;
    scopeInvokePending = true;
    composerOpen = false;
    renderComposer();
    runtimeWindow.pushEvent?.(`开始工作：${summary.text}`, "act");
    // 立刻起转：点下开始到首个 scopeChanged 事件之间的空白最像「没反应」
    busyStart("scope", `正在准备：${summary.count} 章`);
    // 调用返回是跑批结束的权威信号（与单章同一原则：丢一个事件不该让转圈永远转下去）
    const result = await api.invoke("translate.runScope", { workspaceId, chapters: summary.chapters });
    scopeInvokePending = false;
    scopeRun = null;
    busyStop("scope");
    renderComposer();
    if (activeWorkspace?.id !== workspaceId) return;
    if (!result.ok) {
      const message = result.error?.message ?? "翻译失败";
      runtimeWindow.pushEvent?.(message, "err");
      runtimeWindow.showToast?.(message, { duration: 3600 });
      void updateMainActButton();
      return;
    }
    const value = result.value as { approved: string[]; needsReview: string[]; stuck: string[]; skipped: unknown[]; failed: Array<{ chapterId: string; reason: string }>; remaining: string[]; stopped: string; pendingTerms: number };
    const parts = [`完成 ${value.approved.length}`];
    if (value.needsReview.length > 0) parts.push(`待复核 ${value.needsReview.length}`);
    if (value.stuck.length > 0) parts.push(`卡住 ${value.stuck.length}`);
    if (value.failed.length > 0) parts.push(`失败 ${value.failed.length}`);
    if (value.skipped.length > 0) parts.push(`跳过 ${value.skipped.length}`);
    if (value.remaining.length > 0) parts.push(`未跑 ${value.remaining.length}`);
    if (value.pendingTerms > 0) parts.push(`待审术语 ${value.pendingTerms}`);
    const line = `工作结束：${parts.join(" · ")}${value.stopped === "boundary" ? "（在章边界停止）" : value.stopped === "cancelled" ? "（已取消）" : ""}`;
    runtimeWindow.pushEvent?.(line, value.stuck.length + value.failed.length > 0 ? "warn" : "ok");
    runtimeWindow.showToast?.(line, { duration: 5200 });
    // 失败原因逐条出声——汇总数字答不了「哪章、为什么」
    for (const failed of value.failed) runtimeWindow.pushEvent?.(`${scopeChapterTitle(failed.chapterId)} 失败：${failed.reason}`, "err");
    // 卡住的章逐一给人工出口（与单章 stuck 同一条路）
    for (const chapterId of value.stuck) void offerChapterAccept(workspaceId, chapterId, scopeChapterTitle(chapterId));
    await refreshTree();
    updateRealStatusBar();
    void refreshInfoCells();
    void updateMainActButton();
  }

  /** 两段式停止（D7）：以响应立即更新按钮档位，不等事件回来 */
  async function stopScopeRun(): Promise<void> {
    if (!activeWorkspace) return;
    const api = (window as BridgeWindow & { lightee?: { invoke: (command: string, payload: unknown) => Promise<{ ok: boolean; error?: { message?: string }; value?: { status?: string } }> } }).lightee;
    if (!api?.invoke) return;
    const result = await api.invoke("translate.stopScope", { workspaceId: activeWorkspace.id });
    if (!result.ok) {
      runtimeWindow.pushEvent?.(`停止请求失败：${result.error?.message ?? "未知错误"}`, "err");
      return;
    }
    const status = result.value?.status;
    if (status === "boundary") {
      if (scopeRun) scopeRun = { ...scopeRun, stop: "boundary" };
      runtimeWindow.pushEvent?.("将在翻完当前章后停止（再点一次立即取消）", "act");
    } else if (status === "cancelling") {
      if (scopeRun) scopeRun = { ...scopeRun, stop: "cancelled" };
      runtimeWindow.pushEvent?.("正在立即取消当前章…", "act");
    } else {
      runtimeWindow.pushEvent?.("当前没有进行中的工作", "act");
    }
    renderComposer();
  }

  /** 主按钮/demo 入口 → 丝滑跳 Agent 控制台并预填范围（默认未译全选） */
  function openTranslateComposer(): void {
    composerSelection = null;
    composerOpen = true;
    document.querySelector<HTMLElement>("[data-btab=\"agent\"]")?.click();
  }
  /**
   * 熔断章节的人工出口（R5-1）。
   *
   * 放在事件流里而不是弹模态：这是个需要作者先去看问题清单再决定的动作，
   * 弹窗逼着当场表态，只会被顺手点掉——那就等于没有这道人工确认。
   */
  async function offerChapterAccept(workspaceId: string, chapterId: string, title: string): Promise<void> {
    const api = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<{ ok: boolean; error?: { message?: string } }> } }).lightee;
    if (!api?.invoke) return;
    runtimeWindow.pushEvent?.(
      `<span>「${escapeHtml(title)}」需要人工裁决 · <a href="#" data-accept-chapter="${escapeHtml(chapterId)}" style="color:var(--accent)">接受本章</a></span>`,
      "warn"
    );
    document.querySelectorAll<HTMLElement>(`[data-accept-chapter="${chapterId}"]`).forEach((link) => {
      link.onclick = async (event) => {
        event.preventDefault();
        const result = await api.invoke("chapter.accept", { workspaceId, chapterId });
        if (!result?.ok) {
          runtimeWindow.pushEvent?.(result?.error?.message ?? "接受失败", "err");
          return;
        }
        runtimeWindow.pushEvent?.(`已接受「${title}」，本章计入已完成`, "ok");
        runtimeWindow.showToast?.("已接受本章。全书审校需要重新运行。", { duration: 3200 });
        await refreshTree();
        updateRealStatusBar();
      };
    });
  }

  function overrideStartTranslate(): void {
    if ((window as BridgeWindow & { __startTranslateBound?: boolean }).__startTranslateBound) return;
    (window as BridgeWindow & { __startTranslateBound?: boolean }).__startTranslateBound = true;
    // RS-2：demo 的直翻入口与主按钮同路——跳命令栏预填范围，不再静默单章直翻
    (window as unknown as { startTranslate?: () => void }).startTranslate = () => openTranslateComposer();
  }

  async function configureRealExportPanel(): Promise<void> {
    const panel = document.getElementById("export-panel");
    if (!panel || !activeWorkspace) return;
    const workspaceId = activeWorkspace.id;
    const token = workbenchContext.capture("workspace", "export-panel");
    const outputRoot = panel.querySelector<HTMLElement>(".export-output strong");
    if (outputRoot && outputRoot.textContent !== `${activeWorkspace.path}\\output`) outputRoot.textContent = `${activeWorkspace.path}\\output`;
    const selectedScope = currentExportScope(panel);
    const chapters = activeWorkspace.volumes.flatMap((volume) => volume.chapters);
    const summary = composeExport(chapters);
    const active = chapters.find((item) => item.id === activeChapterContent?.chapterId);
    mountChapterPicker(panel, workspaceId, activeWorkspace.volumes);
    // RV-07：判据只剩「真的没有东西可导」。approved 与全书审校都已从后端拆掉，
    // 界面此前还按它们置灰按钮——替一个不存在的规则站岗，作者看到的产品是被挡着的。
    const blocked = exportBlockReason(selectedScope, summary, active, pickedChapterIds(panel));
    if (!workbenchContext.accepts(token) || activeWorkspace?.id !== workspaceId || !panel.isConnected) return;
    const composition = document.getElementById("exp-composition");
    if (composition) {
      const text = describeComposition(summary);
      if (composition.textContent !== text) composition.textContent = text;
    }
    const gate = document.getElementById("exp-gate");
    const run = document.getElementById("exp-run") as HTMLButtonElement | null;
    if (gate) {
      const gateText = blocked ? `暂不可导出 · ${blocked}` : describeExportPlan(selectedScope, summary, pickedChapterIds(panel));
      if (gate.textContent !== gateText) gate.textContent = gateText;
      gate.style.color = blocked ? "var(--yellow)" : "var(--green)";
    }
    if (run) { run.disabled = Boolean(blocked); run.setAttribute("aria-disabled", String(Boolean(blocked))); }
    syncExportPreview(panel);
    bindExportDestination(panel);
    mountBatchAcceptRow(panel, workspaceId, chapters);
    mountArchiveEntry(panel, workspaceId);
  }

  function currentExportScope(panel: HTMLElement): "current" | "book" | "pick" {
    const value = panel.querySelector<HTMLElement>("[data-export-scope].hot")?.dataset.exportScope;
    return value === "book" || value === "pick" ? value : "current";
  }

  function pickedChapterIds(panel: HTMLElement): string[] {
    return [...panel.querySelectorAll<HTMLInputElement>("#exp-chapter-list input[type=checkbox]:checked")].map((box) => box.value);
  }

  /** 产物文件名里代表范围的那一段，与 engine 的 targetSuffix 同一套写法 */
  function exportScopeSuffix(panel: HTMLElement): string {
    const scope = currentExportScope(panel);
    if (scope === "book") return "全卷";
    if (scope === "pick") {
      const picked = pickedChapterIds(panel);
      return picked.length === 1 ? picked[0]! : `选${picked.length}章`;
    }
    return activeChapterContent?.chapterId ?? "章节";
  }

  /** 作者选过的导出目录，按工作区记住（只活到应用退出——它没有落盘的地方） */
  const exportOutDirs = new Map<string, string>();

  function exportExtension(panel: HTMLElement): string {
    const format = panel.querySelector<HTMLElement>("[data-export-format].hot")?.dataset.exportFormat ?? "TXT";
    return format === "Markdown" ? "md" : format === "EPUB" ? "epub" : "txt";
  }

  function exportOutDir(workspaceId: string, workspacePath: string): string {
    return exportOutDirs.get(workspaceId) ?? `${workspacePath}\\output`;
  }

  /**
   * 位置与文件名两行说的是**这次点下去会得到什么**。
   * 从前这里写死 `ch003_zh.txt`——那个名字引擎一次都没生成过，作者照着它去目录里找不到文件。
   * 现在两行都是真的：位置是真会写进去的目录，文件名是真会用的名字（且他能改）。
   */
  function syncExportPreview(panel: HTMLElement): void {
    if (!activeWorkspace) return;
    const ext = exportExtension(panel);
    const bilingual = panel.querySelector("[data-export-bilingual].hot") !== null;
    const dir = exportOutDir(activeWorkspace.id, activeWorkspace.path);
    const dirEl = panel.querySelector<HTMLElement>("#exp-out-dir");
    if (dirEl && dirEl.textContent !== dir) { dirEl.textContent = dir; dirEl.title = dir; }
    const extEl = panel.querySelector<HTMLElement>("#exp-file-ext");
    if (extEl && extEl.textContent !== `.${ext}`) extEl.textContent = `.${ext}`;
    const nameEl = panel.querySelector<HTMLInputElement>("#exp-file-name");
    // 作者自己动过文件名就不再覆盖：那是他打的字，范围换一下就被冲掉是最气人的一种 bug
    if (nameEl && nameEl.dataset.touched !== "1") {
      const stem = `${activeWorkspace.name}_${exportScopeSuffix(panel)}${bilingual ? "_双语" : ""}`;
      if (nameEl.value !== stem) nameEl.value = stem;
    }
  }

  /**
   * 位置与文件名两处输入的绑定。挂一次就够——面板重开时 DOM 还是同一个节点。
   */
  function bindExportDestination(panel: HTMLElement): void {
    if (panel.dataset.destinationBound === "1") return;
    panel.dataset.destinationBound = "1";
    panel.querySelector<HTMLInputElement>("#exp-file-name")?.addEventListener("input", (event) => {
      (event.currentTarget as HTMLInputElement).dataset.touched = "1";
    });
    panel.querySelector("[data-export-pick-dir]")?.addEventListener("click", () => void (async () => {
      if (!activeWorkspace) return;
      const workspaceId = activeWorkspace.id;
      const api = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<{ ok: boolean; value?: { path?: string | null } }> } }).lightee;
      const result = await api?.invoke("dialog.pickDirectory", { title: "选择导出位置" });
      const picked = result?.ok ? result.value?.path : null;
      if (!picked) return;   // 取消不是错误，也不该改动已选的位置
      exportOutDirs.set(workspaceId, picked);
      await configureRealExportPanel();
    })());
  }

  function describeExportPlan(scope: "current" | "book" | "pick", summary: ExportComposition, picked: ReadonlyArray<string>): string {
    if (scope === "current") return "可以导出";
    const withText = new Set([...summary.done, ...summary.draft].map((chapter) => chapter.id));
    const [total, ready] = scope === "book"
      ? [summary.done.length + summary.draft.length + summary.missing.length, withText.size]
      : [picked.length, picked.filter((id) => withText.has(id)).length];
    return total > ready
      ? `导出 ${ready} 章，尚无译文的 ${total - ready} 章不会进产物`
      : `导出 ${ready} 章`;
  }

  /**
   * 章节挑选清单。范围从前只有「当前章节 / 全书」两格，可作者脑子里的范围常常是一份名单
   * ——只寄第三卷、只导已定稿的那十章。此前唯一的做法是整本导出再手工删。
   *
   * 勾选状态按工作区 + 章节名单缓存：面板每次刷新都重建列表的话，作者刚勾好的
   * 二十章会在一次状态事件后清空。
   */
  function mountChapterPicker(panel: HTMLElement, workspaceId: string, volumes: WorkspaceRecord["volumes"]): void {
    const list = panel.querySelector<HTMLElement>("#exp-chapter-list");
    if (!list) return;
    const chapters = volumes.flatMap((volume) => volume.chapters);
    const signature = `${workspaceId}:${chapters.map((chapter) => `${chapter.id}/${chapter.state ?? ""}`).join(",")}`;
    if (list.dataset.signature !== signature) {
      const checked = new Set(pickedChapterIds(panel));
      const multiVolume = volumes.length > 1;
      list.innerHTML = volumes.map((volume) => {
        const rows = volume.chapters.map((chapter) => {
          const label = chapterStateLabel(chapter.state);
          const noText = label === "未译" || label === "翻译中";
          return `<label class="export-pick-row${noText ? " no-text" : ""}"><input type="checkbox" value="${escapeHtml(chapter.id)}"${checked.has(chapter.id) ? " checked" : ""}><span class="pick-title">${escapeHtml(chapter.title || chapter.id)}</span><span class="pick-state">${label}</span></label>`;
        }).join("");
        return multiVolume ? `<div class="export-picker-vol">${escapeHtml(volume.name)}</div>${rows}` : rows;
      }).join("");
      list.dataset.signature = signature;
    }
    updatePickCount(panel);
    if (panel.dataset.pickerBound === "1") return;
    panel.dataset.pickerBound = "1";
    list.addEventListener("change", () => { updatePickCount(panel); void configureRealExportPanel(); });
    panel.querySelector("[data-export-pick-all]")?.addEventListener("click", () => setAllPicked(panel, true));
    panel.querySelector("[data-export-pick-none]")?.addEventListener("click", () => setAllPicked(panel, false));
  }

  function setAllPicked(panel: HTMLElement, value: boolean): void {
    for (const box of panel.querySelectorAll<HTMLInputElement>("#exp-chapter-list input[type=checkbox]")) box.checked = value;
    updatePickCount(panel);
    void configureRealExportPanel();
  }

  /**
   * 写之前必须比一次。整个导出面板挂在一个 `MutationObserver(document.body, subtree)` 上，
   * 面板里任何一次 DOM 变动都会回头再调一次 configureRealExportPanel——
   * 这里无条件 `textContent=` 会重建文本节点，那就是一次 childList 变动，
   * 于是 观察者 → 刷新 → 写文本 → 观察者 …… 主线程被这条环吃干净，界面直接卡死。
   * 面板里其余每一处写入都带着同样的守卫，这一处漏了。
   */
  function updatePickCount(panel: HTMLElement): void {
    const label = panel.querySelector<HTMLElement>("#exp-pick-count");
    if (!label) return;
    const picked = pickedChapterIds(panel).length;
    const total = panel.querySelectorAll("#exp-chapter-list input[type=checkbox]").length;
    const text = picked === 0 ? `未选择章节（共 ${total} 章）` : `已选 ${picked} / ${total} 章`;
    if (label.textContent !== text) label.textContent = text;
  }

  /**
   * 「把这 N 章标记为完成」（RV-07 第 5 条）。只对 `stuck` 章节出现——它是唯一一个
   * 卡在机器判定上、等作者拍板的状态。列出章名再由作者点一次，禁止静默批量：
   * 替作者标记他没看过的章节，等于伪造他的裁决。
   */
  function mountBatchAcceptRow(panel: HTMLElement, workspaceId: string, chapters: ReadonlyArray<{ id: string; title: string; state?: ExportChapterState }>): void {
    const pending = acceptableChapters(chapters);
    const existing = panel.querySelector<HTMLElement>("#exp-batch-accept");
    if (pending.length === 0) { existing?.remove(); return; }
    const row = existing ?? document.createElement("div");
    if (!existing) {
      row.id = "exp-batch-accept";
      row.className = "export-panel-foot";
      row.style.marginTop = "8px";
      panel.appendChild(row);
    }
    const names = pending.map((chapter) => chapter.title).join("、");
    row.innerHTML = `<span id="exp-batch-note" style="color:var(--dimmer);font-size:10px">${pending.length} 章等你拍板：${names}</span><button id="exp-batch-run" class="chip" type="button" data-key-action>标记完成</button>`;
    const button = row.querySelector<HTMLButtonElement>("#exp-batch-run");
    const note = row.querySelector<HTMLElement>("#exp-batch-note");
    button?.addEventListener("click", () => void (async () => {
      if (!button) return;
      button.disabled = true;
      button.textContent = "标记中…";
      const api = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<{ ok: boolean; error?: { message?: string } }> } }).lightee;
      let done = 0;
      const failed: string[] = [];
      for (const chapter of pending) {
        const result = await api?.invoke("chapter.accept", { workspaceId, chapterId: chapter.id });
        if (result?.ok) done += 1;
        else failed.push(chapter.title);
      }
      button.disabled = false;
      button.textContent = "标记完成";
      if (note) note.textContent = failed.length > 0 ? `已完成 ${done} 章，${failed.length} 章没能标记：${failed.join("、")}` : `已完成 ${done} 章`;
      runtimeWindow.pushEvent?.(failed.length > 0 ? `批量标记：${done} 章完成，${failed.length} 章失败` : `批量标记完成 · ${done} 章`, failed.length > 0 ? "err" : "ok");
      await refreshTree();
      await configureRealExportPanel();
    })());
  }

  /**
   * 工作区归档入口（RH-21 / C-2）。挂在导出面板底部——用户想「把这本书保存下来」时
   * 第一反应就是找导出，不该再去设置里翻。
   *
   * 与「导出译文」的区别写在副标题里：这里出的是可完整还原的工作区备份，不是成品稿。
   * 归档不受 approved 门禁限制——备份的意义恰恰在于「还没完成的时候也能救回来」。
   */
  function mountArchiveEntry(panel: HTMLElement, workspaceId: string): void {
    if (panel.querySelector("#ws-archive-row")) return;
    const row = document.createElement("div");
    row.id = "ws-archive-row";
    row.className = "export-panel-foot";
    row.style.marginTop = "8px";
    row.innerHTML = `<span id="ws-archive-status" style="color:var(--dimmer);font-size:10px">备份整个工作区（原文 / 译文 / 术语 / 审校），可完整还原</span><button id="ws-archive-run" class="chip" type="button" data-key-action>导出工作区归档</button>`;
    panel.appendChild(row);
    const button = row.querySelector<HTMLButtonElement>("#ws-archive-run");
    const status = row.querySelector<HTMLElement>("#ws-archive-status");
    button?.addEventListener("click", () => void (async () => {
      if (!button) return;
      button.disabled = true;
      button.textContent = "打包中…";
      const api = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<{ ok: boolean; value?: { status?: string; path?: string; bytes?: number }; error?: { message?: string } }> } }).lightee;
      const result = await api?.invoke("workspace.exportArchive", { workspaceId });
      button.disabled = false;
      button.textContent = "导出工作区归档";
      if (!result?.ok) {
        if (status) status.textContent = result?.error?.message ?? "归档失败";
        runtimeWindow.pushEvent?.(result?.error?.message ?? "工作区归档失败", "err");
        return;
      }
      if (result.value?.status === "cancelled") {
        if (status) status.textContent = "已取消";
        return;
      }
      const mb = Math.max(1, Math.round((result.value?.bytes ?? 0) / 1024 / 1024));
      if (status) status.textContent = `已导出 · 约 ${mb} MB`;
      runtimeWindow.pushEvent?.(`工作区归档已导出 · ${result.value?.path ?? ""}`, "ok");
    })());
  }

  async function runRealExport(): Promise<void> {
    if (!activeWorkspace) return;
    const workspaceId = activeWorkspace.id;
    const token = workbenchContext.capture("workspace", "export-run");
    const panel = document.getElementById("export-panel");
    const button = document.getElementById("exp-run") as HTMLButtonElement | null;
    const status = document.getElementById("exp-status");
    if (!panel || !button || button.disabled) return;
    const formatLabel = panel.querySelector<HTMLElement>("[data-export-format].hot")?.dataset.exportFormat ?? "TXT";
    const scope = currentExportScope(panel);
    // 双语对照是**开关**不是第四种格式：三种格式都能出对照本，从前把它排进格式行，
    // 等于逼作者在「要 EPUB」和「要对照」之间二选一，而当时点它只会得到 md。
    const base = formatLabel === "Markdown" ? "md" : formatLabel === "EPUB" ? "epub" : "txt";
    const bilingual = panel.querySelector("[data-export-bilingual].hot") !== null;
    const format = bilingual ? `${base}-bilingual` : base;
    const target: string | string[] = scope === "book" ? "all"
      : scope === "pick" ? pickedChapterIds(panel)
      : activeChapterContent?.chapterId ?? "";
    if (target.length === 0) { if (status) status.textContent = scope === "pick" ? "先勾选要导出的章节" : "请先打开要导出的章节"; return; }
    button.disabled = true;
    button.textContent = "导出中…";
    button.setAttribute("aria-busy", "true");
    const formatName = bilingual ? `${base.toUpperCase()} 双语对照` : base.toUpperCase();
    if (status) status.textContent = `正在生成 ${formatName}…`;
    const api = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<{ ok: boolean; value?: { outPath?: string; exported?: string[]; fromStaging?: string[]; skipped?: string[] }; error?: { message?: string } }> } }).lightee;
    // 文件名留空 = 「按默认命名」，不是「叫空字符串」；净化与回落都在 engine 里，
    // 这里只负责把作者填的东西原样送过去。
    const fileName = panel.querySelector<HTMLInputElement>("#exp-file-name")?.value.trim();
    const outDir = exportOutDirs.get(workspaceId);
    const result = await api?.invoke("export.run", {
      workspaceId, target, format,
      ...(outDir ? { outDir } : {}),
      ...(fileName ? { fileName } : {}),
    });
    if (!workbenchContext.accepts(token)) return;
    button.textContent = "导出译文";
    button.removeAttribute("aria-busy");
    if (!result?.ok) {
      button.disabled = false;
      if (status) status.textContent = result?.error?.message ?? "导出失败";
      runtimeWindow.pushEvent?.(result?.error?.message ?? "导出失败", "err");
      return;
    }
    // 构成从后端返回的三份名单里来，不从「我请求了什么」里推——
    // 跳过哪几章只有导出引擎知道，界面自己算等于编。
    const composition = describeExportResult(result.value ?? {}, activeWorkspace.volumes.flatMap((volume) => volume.chapters));
    if (status) status.textContent = `${composition} · ${formatName}`;
    runtimeWindow.pushEvent?.(`导出完成 · ${formatName} · ${composition}`, "ok");
    await configureRealExportPanel();
    // 导完之后两行都换成**真的落盘的那条路径**：预览是按规则推的，这个是引擎回报的。
    // 文件名同时标记为「作者动过」——否则下一次刷新会把它按默认规则改回去，
    // 而屏幕上明明写着刚才导出的是另一个名字。
    const outPath = result.value?.outPath;
    const donePanel = document.getElementById("export-panel");
    if (outPath && donePanel) {
      const cut = Math.max(outPath.lastIndexOf("\\"), outPath.lastIndexOf("/"));
      const dir = cut > 0 ? outPath.slice(0, cut) : outPath;
      const base = outPath.slice(cut + 1).replace(/\.[^.]+$/, "");
      const dirEl = donePanel.querySelector<HTMLElement>("#exp-out-dir");
      if (dirEl) { dirEl.textContent = dir; dirEl.title = dir; }
      const nameEl = donePanel.querySelector<HTMLInputElement>("#exp-file-name");
      if (nameEl) { nameEl.value = base; nameEl.dataset.touched = "1"; }
    }
  }

  function overrideRealExport(): void {
    const exportWindow = window as unknown as { runPrototypeExport?: () => void; __realExportBound?: boolean };
    exportWindow.runPrototypeExport = () => void runRealExport();
    if (exportWindow.__realExportBound) return;
    exportWindow.__realExportBound = true;
    // 观察者盯的是整个 body 子树，而刷新面板本身就在改 DOM——它天然是一条环。
    // 从前靠「每一处写入都先比一次」把环掐断，那是一条要求后来的每一次改动都记得遵守的
    // 纪律，漏一处就是主线程卡死（挑选章节的计数那次就漏了）。断环改成结构性的。
    const refreshExportPanel = createReentrantRefresh(
      () => configureRealExportPanel(),
      { shouldRun: () => Boolean(document.getElementById("export-panel")?.childElementCount) },
    );
    const observer = new MutationObserver(refreshExportPanel);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest("[data-export-format],[data-export-scope],[data-export-bilingual]")) return;
      window.setTimeout(refreshExportPanel, 0);
    });
  }

  // ===== 阶段 B：真实术语确认 tab（confirm.list / confirm.decide） =====
  interface ConfirmEvidenceUI { context?: string; snippet?: string; source?: string; }
  interface ConfirmCardUI {
    ja: string;
    reading?: string;
    type: string;
    cardKind?: string;
    context?: string;
    note?: string;
    metadata?: {
      character?: string;
      selfRefJa?: string;
      selfRefZh?: string;
      particlesJa?: string[];
      zhStrategy?: string;
      voiceAttribution?: { status?: string; evidenceBlockIds?: string[]; register?: string };
    };
    candidates: Array<{ zh: string; confidence: number; evidence?: ConfirmEvidenceUI[] }>;
  }
  interface ConfirmListValue { cards: ConfirmCardUI[]; session: { index: number; done: boolean } | null; status: { status: string; cardCount?: number; pendingCount?: number; confirmedCount?: number }; revision: number; }
  function termTypeLabel(type: string): string {
    const map: Record<string, string> = { name: "人名/专名", term: "术语", onomatopoeia: "拟声拟态", voice: "角色语气", pun: "谐音梗" };
    return map[type] ?? type;
  }
  function termEvidenceText(candidate: { zh: string; confidence: number; evidence?: Array<{ context?: string; snippet?: string; source?: string }> }): string {
    const first = candidate.evidence?.[0];
    return (first?.snippet ?? first?.context ?? "").slice(0, 60);
  }
  // EX-07 / ADR-0007：runTermExtract（terminology.prepare 的界面入口）随译前阶段一起退役。

  async function decideTerm(workspaceId: string, action: "accept" | "modify" | "skip" | "back", chosenZh: string | undefined, expectedIndex: number, chosenCharacter?: string): Promise<boolean> {
    const token = workbenchContext.capture("tab");
    const api = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<{ ok: boolean; error?: { code?: string; message?: string } }> } }).lightee;
    const payload: Record<string, unknown> = { workspaceId, action };
    if (chosenZh !== undefined) payload.chosenZh = chosenZh;
    if (chosenCharacter !== undefined) payload.chosenCharacter = chosenCharacter;
    payload.expectedIndex = expectedIndex;
    const result = await api?.invoke("confirm.decide", payload);
    if (!workbenchContext.accepts(token)) return Boolean(result?.ok);
    if (!result?.ok) {
      // not_found = 会话已经不在了（换书、重导入、别处清空）。此时屏幕上这几张卡是残影，
      // 只弹一句报错就等于让作者对着不存在的东西继续点。重画一遍，让界面回到真值。
      const stale = result?.error?.code === "not_found";
      const message = stale ? "这批待确认术语已经不在了，界面已刷新" : result?.error?.message ?? "操作失败";
      runtimeWindow.pushEvent?.(message, "err");
      runtimeWindow.showToast?.(message, { duration: 3200 });
      if (stale) { await renderTermsPanel(workspaceId); await updateTermBadge(workspaceId); }
      return false;
    }
    runtimeWindow.pushEvent?.(action === "accept" ? `已确认术语` : action === "modify" ? `已采用自定义译名` : action === "skip" ? `已跳过` : `已返回上一张`, "act");
    await renderTermsPanel(workspaceId);
    await updateTermBadge(workspaceId);
    void updateMainActButton();
    return true;
  }
  interface EditableTermRecord {
    /** 展示 id，带 `档案名:` 前缀与去重后缀——仓库里没有这个键，不能拿来改数据 */
    id: string;
    /** 仓库里的真实条目 id，改/删/还原认的是它 */
    entryId?: string;
    sourceId?: string;
    archive?: "names" | "terms" | "voice" | "onomatopoeia" | "puns" | "preDict" | "postDict" | "noTranslate";
    ja: string;
    zh: string;
    type?: string;
    character?: string;
    selfRefJa?: string;
    selfRefZh?: string;
    zhStrategy?: string;
    gender?: string;
    note?: string;
    enabled?: boolean;
    status?: string;
    provenance?: string;
    /** 软件建库时播种的内置规则（来源标注：不是作者加的，也不是模型加的） */
    builtin?: boolean;
  }
  /** 作者字典档案：不是 Agent 提取的成果，字段语义是「查找/替换」而不是「原文/译法」 */
  const DICT_ARCHIVES = new Set(["preDict", "postDict", "noTranslate"]);
  // EX-07：canTranslate 参数退役——术语确认不再是翻译的前置条件，「开始整章翻译」永远可点。
  /**
   * 术语表管理页的删除。软删——条目连同它所属的档案一起进回收站，
   * 「撤销」用 terms.restore 原位放回（回收站条目记着 originalIndex 和 archive）。
   *
   * 删除只改术语表，已翻正文一个字不动：术语表管的是**之后**怎么翻。
   * 这与改译名相反——那条会追溯替换旧译名，界面上的说明必须区分开。
   */
  async function deleteConfirmedTerm(workspaceId: string, term: EditableTermRecord, revision: number): Promise<void> {
    const api = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<{ ok: boolean; error?: { code?: string; message?: string }; value?: { revision: number } }> } }).lightee;
    if (!api?.invoke) return;
    const archive = term.archive ?? "terms";
    const label = term.archive === "voice" ? `${term.character?.trim() || "待指定角色"} / ${term.selfRefJa || term.ja}` : term.ja;
    // 必须用 entryId：列表里的 id 是摊平八个档案时造的展示 id（带 `档案名:` 前缀），
    // 仓库里不存在，拿它去删只会得到 not_found。
    const termId = term.entryId ?? term.id;
    const result = await api.invoke("terms.delete", { workspaceId, termId, archive, baseRevision: revision });
    if (!result.ok) {
      runtimeWindow.showToast?.(
        result.error?.code === "conflict" ? "术语表刚被更新，已刷新——请再试一次" : result.error?.message ?? "删除失败",
        { duration: 3200 },
      );
      await renderConfirmedTerms(workspaceId);
      return;
    }
    // 还原要用**删除之后**的版本号：拿删除前的那个去写，后端只会回 conflict
    const afterDelete = result.value?.revision ?? revision + 1;
    await renderConfirmedTerms(workspaceId);
    void updateTermBadge(workspaceId);
    runtimeWindow.showToast?.(`已删除「${label}」· 之后的翻译不再用它`, {
      duration: 6000,
      undo: () => void (async () => {
        const restored = await api.invoke("terms.restore", { workspaceId, termId, archive, baseRevision: afterDelete });
        if (!restored.ok) {
          runtimeWindow.showToast?.(restored.error?.message ?? "还原失败", { duration: 3200 });
          return;
        }
        await renderConfirmedTerms(workspaceId);
        void updateTermBadge(workspaceId);
        runtimeWindow.showToast?.(`已还原「${label}」`, { duration: 2400 });
      })(),
    });
  }

  async function renderConfirmedTerms(workspaceId: string): Promise<void> {
    // 独立泳道，**不能**和 renderTermsPanel 共用一条。
    // 两者是调用关系（renderTermsPanel → renderConfirmedTerms），共用泳道时子调用的
    // capture 会把父调用的令牌顶掉；再叠上 terms.changed 事件另起的一条渲染链，两条链
    // 互相作废，双双在 await 之后原样返回——面板一个字不改，于是刚确认掉的那张卡还留在
    // 屏幕上，还能点，点下去后端说会话已结束。
    const token = workbenchContext.capture("tab", "terms-directory");
    const panel = document.getElementById("bpanel");
    const api = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<{ ok: boolean; error?: { message?: string }; value?: { items: EditableTermRecord[]; revision: number } }> } }).lightee;
    if (!panel || !api?.invoke) return;
    const queried = await api.invoke("terms.query", { workspaceId });
    if (!workbenchContext.accepts(token) || activeBtab() !== "terms") return;
    if (!queried.ok || !queried.value) {
      panel.innerHTML = `<div class="tw-empty"><h2>无法读取术语表</h2><p>${escapeHtml(queried.error?.message ?? "未知错误")}</p></div>`;
      return;
    }
    const terms = queried.value.items;
    const revision = queried.value.revision;
    const archiveLabels: Record<string, string> = { names: "人名/专名", terms: "普通术语", voice: "角色语气", onomatopoeia: "拟声拟态", puns: "谐音梗", preDict: "译前字典", postDict: "译后字典", noTranslate: "禁翻表" };
    const termLabel = (term: EditableTermRecord): string => term.archive === "voice"
      ? `${term.character?.trim() || "待指定角色"} / ${term.selfRefJa || term.ja}`
      : term.ja;
    panel.innerHTML = `
      <div class="tw-done">
        <div class="tw-head">
          <div><h2>本书术语表</h2><p>术语表决定 AI 怎么翻这些词。</p></div>
          <div class="tw-count"><strong>${terms.length}</strong><span>条权威记录</span><small>作者可编辑</small></div>
        </div>
        <div class="tw-toolbar">
          <button class="tw-btn primary" id="tw-add-term">添加条目</button>
          <!-- 从前写的是「正文不会被自动覆盖」——EX-06 追溯改名上线后它就成了假话。 -->
          <ul class="tw-ops">
            <li><b>添加</b> 你自己的译法，保存后立即对之后的翻译生效</li>
            <li><b>改译名</b> 会快捷替换所有旧译名</li>
            <li><b>删除</b> 只影响之后的翻译，已翻正文不动</li>
          </ul>
        </div>
        <form class="tw-term-form" id="tw-term-form" hidden>
          <input type="hidden" id="tw-term-id">
          <div class="tw-form-title"><strong id="tw-form-title">添加条目</strong><button type="button" class="tw-icon-btn" id="tw-form-close" aria-label="关闭编辑">×</button></div>
          <div class="tw-form-grid">
            <label>档案<select id="tw-term-archive"><optgroup label="术语"><option value="terms">普通术语</option><option value="names">人名/专名</option><option value="voice">角色语气</option><option value="onomatopoeia">拟声拟态</option><option value="puns">谐音梗</option></optgroup><optgroup label="字典（作者规则，确定性执行）"><option value="preDict">译前字典</option><option value="postDict">译后字典</option><option value="noTranslate">禁翻表</option></optgroup></select></label>
            <label id="tw-character-field" hidden>角色<input id="tw-term-character" maxlength="256" placeholder="这条语气属于哪个角色"></label>
            <label id="tw-gender-field" hidden>性别<select id="tw-term-gender"><option value="">未判定</option><option value="female">女</option><option value="male">男</option></select></label>
            <label><span id="tw-ja-label">日文</span><input id="tw-term-ja" maxlength="256" required></label>
            <label id="tw-zh-field"><span id="tw-zh-label">中文</span><input id="tw-term-zh" maxlength="256" required></label>
            <label class="tw-strategy-field" id="tw-strategy-field" hidden><span id="tw-strategy-label">中文语气策略</span><textarea id="tw-term-strategy" maxlength="4000" rows="2"></textarea></label>
            <label id="tw-regex-field" hidden><input type="checkbox" id="tw-term-regex"> 按正则解释（支持 $1 捕获引用）</label>
            <label id="tw-enabled-field" hidden><input type="checkbox" id="tw-term-enabled" checked> 启用这条规则</label>
          </div>
          <div class="tw-form-error" id="tw-form-error" role="alert"></div>
          <div class="tw-actions"><button type="button" class="tw-btn" id="tw-form-cancel">取消</button><button type="submit" class="tw-btn primary" id="tw-form-save">保存</button></div>
        </form>
        <!-- 规则条目带 note 时把人话说明摊在下面：内置的两条对话标点规则只摆裸正则时，
             作者读不出它到底动了什么（实测被误读成「把对话结尾一律改成句号」）。 -->
        <div class="tw-list">${terms.map((term: EditableTermRecord, index: number) => `<div class="tw-row tw-editable-row"><span class="tw-row-ja">${escapeHtml(termLabel(term))}<small>${escapeHtml(archiveLabels[term.archive ?? "terms"] ?? "术语")}${term.type === "regex" ? " · 正则" : ""}${term.builtin ? " · 软件内置" : ""}${term.enabled === false ? " · 已停用" : ""}${term.status === "pending_review" ? " · 待作者确认" : ""}${term.provenance === "model" ? " · 模型暂定" : ""}</small></span><b>${escapeHtml(term.archive === "voice" ? term.selfRefZh || term.zh : term.archive === "noTranslate" ? "原样保留" : term.zh)}</b><span class="tw-row-ops"><button class="tw-icon-btn" data-term-edit="${index}" aria-label="编辑 ${escapeHtml(termLabel(term))}">编辑</button><button class="tw-icon-btn danger" data-term-delete="${index}" aria-label="删除 ${escapeHtml(termLabel(term))}">删除</button></span></div>${term.note && DICT_ARCHIVES.has(term.archive ?? "") ? `<div class="tw-row-note">${escapeHtml(term.note)}</div>` : ""}`).join("") || `<div class="tw-list-empty">还没有词条。你在这里加的译法，翻译时会照着用。</div>`}</div>
        <div class="tw-actions">
          <button class="tw-btn primary" id="tw-start">开始整章翻译</button>
        </div>
      </div>`;

    const form = document.getElementById("tw-term-form") as HTMLFormElement | null;
    const archive = document.getElementById("tw-term-archive") as HTMLSelectElement | null;
    const idInput = document.getElementById("tw-term-id") as HTMLInputElement | null;
    const jaInput = document.getElementById("tw-term-ja") as HTMLInputElement | null;
    const zhInput = document.getElementById("tw-term-zh") as HTMLInputElement | null;
    const characterInput = document.getElementById("tw-term-character") as HTMLInputElement | null;
    const strategyInput = document.getElementById("tw-term-strategy") as HTMLTextAreaElement | null;
    const error = document.getElementById("tw-form-error");
    const genderInput = document.getElementById("tw-term-gender") as HTMLSelectElement | null;
    const regexInput = document.getElementById("tw-term-regex") as HTMLInputElement | null;
    const enabledInput = document.getElementById("tw-term-enabled") as HTMLInputElement | null;
    // 同一张表单服务两类东西：术语是「原文→译法」，字典是「查找→替换」。
    // 字段不改标就会引导作者把译后字典填成日译中——译后字典的查找侧是中文。
    const syncArchiveFields = (): void => {
      const value = archive?.value ?? "terms";
      const voice = value === "voice";
      const dict = DICT_ARCHIVES.has(value);
      const noTranslate = value === "noTranslate";
      const rule = value === "preDict" || value === "postDict";
      // 双关卡复用 strategy 这一栏承载梗的解释：它会原样写进译文的（译注: …），
      // 不给输入口的话作者手动登记的梗只能是一对空括号。
      const pun = value === "puns";
      document.getElementById("tw-character-field")?.toggleAttribute("hidden", !voice);
      document.getElementById("tw-gender-field")?.toggleAttribute("hidden", !voice);
      document.getElementById("tw-strategy-field")?.toggleAttribute("hidden", !voice && !noTranslate && !pun);
      document.getElementById("tw-zh-field")?.toggleAttribute("hidden", noTranslate);
      document.getElementById("tw-regex-field")?.toggleAttribute("hidden", !rule);
      document.getElementById("tw-enabled-field")?.toggleAttribute("hidden", !dict);
      const jaLabel = document.getElementById("tw-ja-label");
      const zhLabel = document.getElementById("tw-zh-label");
      const strategyLabel = document.getElementById("tw-strategy-label");
      if (jaLabel) jaLabel.textContent = voice ? "日文自称" : value === "preDict" ? "原文中查找" : value === "postDict" ? "译文中查找" : noTranslate ? "禁翻词（原文串）" : "日文";
      if (zhLabel) zhLabel.textContent = voice ? "中文自称" : rule ? "替换为" : "中文";
      if (strategyLabel) strategyLabel.textContent = noTranslate ? "备注（可选）" : pun ? "梗的解释（会写进译注；留空则这个梗不加译注）" : "中文语气策略";
      if (characterInput) characterInput.required = voice;
      // 禁翻是恒等映射，没有「替换为」可填；required 留着会让表单永远提交不了
      if (zhInput) zhInput.required = !noTranslate;
    };
    const openForm = (term?: EditableTermRecord): void => {
      if (!form || !archive || !idInput || !jaInput || !zhInput || !characterInput || !strategyInput) return;
      form.hidden = false;
      // 编辑走 terms.update，同样要仓库里的真实 id，不是列表用的展示 id
      idInput.value = term?.entryId ?? term?.id ?? "";
      archive.value = term?.archive ?? "terms";
      archive.disabled = Boolean(term);
      jaInput.value = term?.archive === "voice" ? term.selfRefJa ?? term.ja : term?.ja ?? "";
      zhInput.value = term?.archive === "voice" ? term.selfRefZh ?? term.zh : term?.zh ?? "";
      characterInput.value = term?.character ?? "";
      strategyInput.value = term?.archive === "noTranslate" || term?.archive === "puns" ? term.note ?? "" : term?.zhStrategy ?? "";
      if (genderInput) genderInput.value = term?.gender === "female" || term?.gender === "male" ? term.gender : "";
      if (regexInput) regexInput.checked = term?.type === "regex";
      if (enabledInput) enabledInput.checked = term?.enabled !== false;
      const title = document.getElementById("tw-form-title");
      if (title) title.textContent = term ? "编辑条目" : "添加条目";
      if (error) error.textContent = "";
      syncArchiveFields();
      (term?.archive === "voice" && !characterInput.value ? characterInput : jaInput).focus();
    };
    const closeForm = (): void => { if (form) form.hidden = true; };
    archive?.addEventListener("change", syncArchiveFields);
    document.getElementById("tw-add-term")?.addEventListener("click", () => openForm());
    document.querySelectorAll<HTMLElement>("[data-term-edit]").forEach((button) => button.addEventListener("click", () => openForm(terms[Number(button.dataset.termEdit)])));
    // 删除走软删：条目进回收站，撤销即还原。不弹二次确认——撤销是更好的确认，
    // 而 archive 必须一起送出去，否则后端在 terms 表里找一条人名，报的是 not_found。
    document.querySelectorAll<HTMLElement>("[data-term-delete]").forEach((button) => button.addEventListener("click", () => {
      const term = terms[Number(button.dataset.termDelete)];
      if (term) void deleteConfirmedTerm(workspaceId, term, revision);
    }));
    document.getElementById("tw-form-close")?.addEventListener("click", closeForm);
    document.getElementById("tw-form-cancel")?.addEventListener("click", closeForm);
    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!archive || !idInput || !jaInput || !zhInput || !characterInput || !strategyInput) return;
      if (archive.value === "voice" && !characterInput.value.trim()) { if (error) error.textContent = "请指定这条语气属于哪个角色。"; characterInput.focus(); return; }
      const isDict = DICT_ARCHIVES.has(archive.value);
      const isRule = archive.value === "preDict" || archive.value === "postDict";
      // 正则先在这里编译一次：写坏的规则在引擎里是被静默跳过的，不当场报出来作者只会以为它生效了
      if (isRule && regexInput?.checked) {
        try {
          new RegExp(jaInput.value);
        } catch (cause) {
          if (error) error.textContent = `正则写法有误：${cause instanceof Error ? cause.message : "无法编译"}`;
          jaInput.focus();
          return;
        }
      }
      const save = document.getElementById("tw-form-save") as HTMLButtonElement | null;
      if (save) save.disabled = true;
      const ja = jaInput.value.trim();
      const payload = {
        workspaceId,
        archive: archive.value,
        ja,
        // 禁翻是恒等映射：契约要求 zh 非空，这里由界面补上，作者不必填一遍同样的词
        zh: archive.value === "noTranslate" ? ja : zhInput.value.trim(),
        character: characterInput.value.trim() || undefined,
        strategy: strategyInput.value.trim() || undefined,
        ...(archive.value === "voice" && genderInput?.value ? { gender: genderInput.value } : {}),
        ...(isRule ? { type: regexInput?.checked ? "regex" : "literal" } : {}),
        ...(isDict ? { enabled: enabledInput?.checked !== false } : {}),
        baseRevision: revision,
      };
      const result = await api.invoke(idInput.value ? "terms.update" : "terms.create", idInput.value ? { ...payload, termId: idInput.value } : payload);
      if (!result.ok) {
        if (error) error.textContent = result.error?.message ?? "保存失败，请重试。";
        if (save) save.disabled = false;
        return;
      }
      runtimeWindow.showToast?.("术语已保存", { duration: 2200 });
      await renderConfirmedTerms(workspaceId);
    });
    document.getElementById("tw-start")?.addEventListener("click", () => { (window as unknown as { startTranslate?: () => void }).startTranslate?.(); });
  }
  // ===== 术语终审（ADR-0008 / RS-2）：档案暂定词条的确认/改译/拒绝 =====

  interface ProvisionalTerm { id: string; archive: "names" | "terms"; ja: string; zh: string; type?: string }
  interface ProvisionalQuery { items: ProvisionalTerm[]; revision: number }

  /** 档案里 provenance=model 的暂定词条。翻页取全——终审队列漏一页就是静默丢词 */
  async function queryProvisionalTerms(workspaceId: string): Promise<ProvisionalQuery> {
    const api = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<{ ok: boolean; value?: { items: Array<Record<string, unknown>>; nextCursor: number | null; revision: number } }> } }).lightee;
    if (!api?.invoke) return { items: [], revision: 0 };
    const items: ProvisionalTerm[] = [];
    let cursor: number | undefined;
    let revision = 0;
    for (let page = 0; page < 40; page += 1) {
      const result = await api.invoke("terms.query", { workspaceId, ...(cursor !== undefined ? { cursor, baseRevision: revision } : {}) });
      if (!result?.ok || !result.value) break;
      revision = result.value.revision;
      for (const item of result.value.items) {
        if (item.provenance !== "model") continue;
        if (item.archive !== "names" && item.archive !== "terms") continue;
        if (typeof item.id !== "string" || typeof item.ja !== "string" || typeof item.zh !== "string") continue;
        items.push({ id: item.id, archive: item.archive, ja: item.ja, zh: item.zh, ...(typeof item.type === "string" ? { type: item.type } : {}) });
      }
      if (result.value.nextCursor === null) break;
      cursor = result.value.nextCursor;
    }
    return { items, revision };
  }

  function provisionalSectionHtml(items: ProvisionalTerm[]): string {
    if (items.length === 0) return "";
    return `<div class="tw-provisional">
      <div class="tw-prov-head"><strong>模型暂定 · ${items.length} 条</strong><span>后面的章节已在沿用这些译法，逐条过目即可</span></div>
      <div class="tw-prov-list">${items.map((term) => `<div class="tw-prov-row" data-prov-row="${escapeHtml(term.id)}">
        <span class="tw-prov-ja">${escapeHtml(term.ja)}<small>${term.archive === "names" ? "人名/专名" : "术语"}</small></span>
        <b class="tw-prov-zh">${escapeHtml(term.zh)}</b>
        <span class="tw-prov-acts">
          <button class="tw-btn tw-sm" data-prov-confirm="${escapeHtml(term.id)}" title="定下这个译法，模型以后不会再改它">确认</button>
          <button class="tw-btn tw-sm" data-prov-edit="${escapeHtml(term.id)}" title="换一个译法，已翻章节里的旧译名会跟着换">改译</button>
          <button class="tw-btn tw-sm tw-danger" data-prov-reject="${escapeHtml(term.id)}" title="从术语表删掉，之后的章节不再用这个译法；回收站可找回">拒绝</button>
        </span>
      </div>`).join("")}</div>
    </div>`;
  }

  function bindProvisionalActions(panel: HTMLElement, workspaceId: string, query: ProvisionalQuery): void {
    const byId = new Map(query.items.map((term) => [term.id, term]));
    panel.querySelectorAll<HTMLElement>("[data-prov-confirm]").forEach((button) => button.addEventListener("click", () => {
      const term = byId.get(button.dataset.provConfirm ?? "");
      if (term) void decideProvisional(workspaceId, term, query.revision);
    }));
    panel.querySelectorAll<HTMLElement>("[data-prov-reject]").forEach((button) => button.addEventListener("click", () => {
      const term = byId.get(button.dataset.provReject ?? "");
      if (term) void decideProvisional(workspaceId, term, query.revision, { reject: true });
    }));
    panel.querySelectorAll<HTMLElement>("[data-prov-edit]").forEach((button) => button.addEventListener("click", () => {
      const term = byId.get(button.dataset.provEdit ?? "");
      const row = term ? panel.querySelector<HTMLElement>(`[data-prov-row="${term.id}"]`) : null;
      if (!term || !row) return;
      // 行内改译：不弹模态。占掉动作区，输入新译法后回车/确定提交
      const acts = row.querySelector<HTMLElement>(".tw-prov-acts");
      if (!acts) return;
      acts.innerHTML = `<input class="tw-prov-input" value="${escapeHtml(term.zh)}" maxlength="256" aria-label="新译法"><button class="tw-btn tw-sm primary" data-prov-save>改译并追溯</button>`;
      const input = acts.querySelector<HTMLInputElement>(".tw-prov-input");
      const submit = (): void => {
        const newZh = input?.value.trim() ?? "";
        if (!newZh) { input?.focus(); return; }
        void decideProvisional(workspaceId, term, query.revision, { newZh });
      };
      acts.querySelector<HTMLElement>("[data-prov-save]")?.addEventListener("click", submit);
      input?.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); submit(); } });
      input?.focus();
      input?.select();
    }));
  }

  /**
   * 终审三动作零新 IPC（TP-2 施工偏差记录）：确认/改译 = terms.update
   * （updateTerm 的 patch 带 provenance:"author"，改 zh 时既有 renameContext
   * 自动触发追溯改名）；拒绝 = terms.delete（回收站带档案归属，可还原）。
   */
  async function decideProvisional(
    workspaceId: string,
    term: ProvisionalTerm,
    revision: number,
    action: { reject?: boolean; newZh?: string } = {},
  ): Promise<void> {
    const api = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<{ ok: boolean; error?: { code?: string; message?: string }; value?: unknown }> } }).lightee;
    if (!api?.invoke) return;
    const result = action.reject
      // archive 必须带：暂定人名进的是 names 档案，不带就落到 terms 表里找不到（not_found）
      ? await api.invoke("terms.delete", { workspaceId, termId: term.id, archive: term.archive, baseRevision: revision })
      : await api.invoke("terms.update", { workspaceId, termId: term.id, archive: term.archive, ja: term.ja, zh: action.newZh ?? term.zh, ...(term.type ? { type: term.type } : {}), baseRevision: revision });
    if (!result.ok) {
      // conflict = 期间有别的写入（比如跑批正在登记新词）——重读重画，不覆盖别人的修改
      runtimeWindow.showToast?.(result.error?.code === "conflict" ? "术语表刚被更新，已刷新——请再试一次" : result.error?.message ?? "操作失败", { duration: 3200 });
      await renderTermsPanel(workspaceId);
      return;
    }
    const repair = (result.value as { renameRepair?: { replaced: number; chapters: number; queued: number; blocked?: string } } | undefined)?.renameRepair;
    if (action.newZh && repair) {
      // 追溯结果如实报数：改了多少段、多少章、多少处进了人工复核队列
      runtimeWindow.showToast?.(`已改译「${term.ja} → ${action.newZh}」· 追溯 ${repair.replaced} 段 / ${repair.chapters} 章${repair.queued > 0 ? ` · ${repair.queued} 处待人工复核` : ""}`, { duration: 4200 });
    } else if (action.reject) {
      runtimeWindow.showToast?.(`已拒绝「${term.ja}」（可从回收站还原）`, { duration: 2800 });
    } else {
      runtimeWindow.showToast?.(`已定稿「${term.ja} → ${term.zh}」`, { duration: 2400 });
    }
    await renderTermsPanel(workspaceId);
    void updateTermBadge(workspaceId);
  }

  async function renderTermsPanel(workspaceId: string): Promise<void> {
    // 竞态防护：仅当同一工作区的 terms tab 仍激活时才写 bpanel。
    if (activeBtab() !== "terms") return;
    const token = workbenchContext.capture("tab", "terms-panel");
    const panel = document.getElementById("bpanel");
    if (!panel) return;
    const api = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<{ ok: boolean; error?: { message?: string }; value?: ConfirmListValue }> } }).lightee;
    const list = await api?.invoke("confirm.list", { workspaceId });
    if (!workbenchContext.accepts(token) || activeBtab() !== "terms") return;
    if (!list?.ok || !list.value) { panel.innerHTML = `<div class="tw-empty"><h2>无法读取术语状态</h2><p>${escapeHtml(list?.error?.message ?? "未知错误")}</p></div>`; return; }
    const { cards, session, status } = list.value;
    const statusName = status?.status ?? "not-extracted";
    const index = session?.index ?? 0;
    const current = cards?.[index];
    // ADR-0008 终审面（两来源一队列）：档案暂定词条（provenance=model，登记即注入、
    // **已在后续章节生效**）与传统确认卡（双关/无译法词）在同一页呈现。
    const provisional = await queryProvisionalTerms(workspaceId);
    if (!workbenchContext.accepts(token) || activeBtab() !== "terms") return;
    // 已完成：术语状态 confirmed 且没有暂定词条 → 完成态 + 已确认列表
    if (statusName === "confirmed" && provisional.items.length === 0) { await renderConfirmedTerms(workspaceId); updateTermBadge(workspaceId); return; }
    if (!current) {
      if (provisional.items.length > 0) {
        // 只有暂定词条：终审页。翻译没有被拦住——确认与否都不影响跑批继续。
        panel.innerHTML = `
          <div class="tw-done">
            <div class="tw-head">
              <div><span class="tw-kicker">术语终审</span><h2>模型暂定的译法</h2><p>这些译法是模型在翻译时定下的，后面的章节已经在照着用。点「确认」，这个译法定下来，模型以后不会再动它；点「改译」，已翻章节里的旧译名会跟着换，拿不准的位置留给你逐处核对；点「拒绝」，这条从术语表删掉，回收站里可以找回。</p></div>
              <div class="tw-count"><strong>${provisional.items.length}</strong><span>条待你过目</span></div>
            </div>
            ${provisionalSectionHtml(provisional.items)}
            <div class="tw-actions"><button class="tw-btn" id="tw-manage-terms">管理术语表</button></div>
          </div>`;
        bindProvisionalActions(panel, workspaceId, provisional);
        document.getElementById("tw-manage-terms")?.addEventListener("click", () => void renderConfirmedTerms(workspaceId));
        return;
      }
      // EX-07 / ADR-0007：「运行术语提取」按钮在此退役。译前那一趟全书扫描不复存在，
      // 术语随翻译逐章到达；这里从「开工前的必经关卡」改成「还没有待确认的词」。
      panel.innerHTML = `
        <div class="tw-empty">
          <span class="tw-empty-mark">◇</span>
          <h2>还没有待确认的术语</h2>
          <p>译名在翻译过程中逐章产生：翻完一章，这一章里需要固定译法的专名会出现在这里等你确认。改了译法，已翻章节会自动跟着改。</p>
          <div class="tw-steps" style="padding:8px 0 0"><span class="active"><b>1</b>整章翻译</span><i>→</i><span><b>2</b>术语确认</span><i>→</i><span><b>3</b>作者修订</span></div>
          <div class="tw-actions" style="margin-top:14px"><button class="tw-btn" id="tw-manage-terms">直接管理术语表</button></div>
        </div>`;
      document.getElementById("tw-manage-terms")?.addEventListener("click", () => void renderConfirmedTerms(workspaceId));
      return;
    }
    // 确认中：渲染当前卡
    const isConfirm = current.cardKind === "confirm";
    const remaining = Math.max(0, (cards?.length ?? 0) - index);
    const confirmedTerms = await adapter.queryTerms(workspaceId);
    if (!workbenchContext.accepts(token)) return;
    panel.innerHTML = `
      <div class="tw-confirm">
        <div class="tw-head">
          <div><span class="tw-kicker">翻译前 · 术语确认</span><h2>${escapeHtml(current.ja)}</h2><p>确认结果会写入本书术语权威；翻译 Agent 只能使用已确认译法。</p></div>
          <div class="tw-count"><strong>${index + 1}/${cards?.length ?? 0}</strong><span>${remaining} 张待确认</span><small>${confirmedTerms.length} 项已确认</small></div>
        </div>
        <div class="tw-steps">
          <span class="active"><b>1</b>术语确认</span><i>→</i><span><b>2</b>整章翻译</span><i>→</i><span><b>3</b>作者修订</span>
        </div>
        ${provisionalSectionHtml(provisional.items)}
        <div class="tw-grid">
          <div class="tw-main">
            <div class="tw-card">
              <div class="tw-ja">${escapeHtml(current.ja)}${current.reading ? `<span class="tw-reading">${escapeHtml(current.reading)}</span>` : ""}</div>
              <div class="tw-meta"><span class="tw-type">${escapeHtml(termTypeLabel(current.type))}</span></div>
              ${current.type === "voice" ? `
                <div class="tw-voice-fields">
                  <label><span>角色</span><input id="tw-voice-character" value="${escapeHtml(current.metadata?.character ?? "")}" placeholder="指定说话者" maxlength="256"></label>
                  <label><span>${current.metadata?.selfRefJa ? `中文自称 · ${escapeHtml(current.metadata.selfRefJa)}` : "中文自称 · 原文未出现"}</span><input id="tw-voice-zh" value="${escapeHtml(current.metadata?.selfRefJa ? current.metadata?.selfRefZh ?? current.candidates?.[0]?.zh ?? "" : "")}" placeholder="${current.metadata?.selfRefJa ? "例如：我" : "可留空"}" maxlength="256"></label>
                </div>
                <div class="tw-voice-summary">
                  <span><b>日文自称</b>${escapeHtml(current.metadata?.selfRefJa || "未观察到")}</span>
                  <span><b>口癖</b>${current.metadata?.particlesJa?.length ? current.metadata.particlesJa.map((particle: string) => `<i>${escapeHtml(particle)}</i>`).join("") : "未提取"}</span>
                  <span><b>中文策略</b>${escapeHtml(current.metadata?.zhStrategy || current.note || "待作者判断")}</span>
                </div>` : ""}
              ${current.type !== "voice" && current.context ? `<div class="tw-ctx"><small>首现上下文</small>${escapeHtml(current.context)}</div>` : ""}
              ${current.type === "voice" ? `<div class="tw-evidence"><strong>原文证据 <small>${current.candidates?.[0]?.evidence?.length ?? 0} 条</small></strong>${(current.candidates?.[0]?.evidence ?? []).slice(0, 5).map((evidence: ConfirmEvidenceUI, evidenceIndex: number) => `<blockquote><span>${evidenceIndex + 1}</span><p>${escapeHtml(evidence.snippet ?? evidence.context ?? "")}</p></blockquote>`).join("") || `<p class="tw-evidence-empty">没有可展示的原文证据，建议暂不确认。</p>`}</div>` : ""}
              ${isConfirm
                ? current.type === "voice" ? "" : `<div class="tw-note">${escapeHtml(current.note ?? "请确认此项处理方案")}</div>`
                : `<div class="tw-cands">${((current.candidates ?? []) as Array<{ zh: string; confidence: number; evidence?: Array<{ context?: string; source?: string }> }>).map((c: { zh: string; confidence: number; evidence?: Array<{ context?: string; source?: string }> }, i: number) => `
                  <div class="tw-cand" data-i="${i}">
                    <span class="tw-cand-mark">✓</span>
                    <span class="tw-cand-zh">${escapeHtml(c.zh)}</span>
                    <span class="tw-cand-conf">${Math.round((c.confidence ?? 0) * 100)}%</span>
                    <span class="tw-cand-ev">${escapeHtml(termEvidenceText(c))}</span>
                  </div>`).join("")}</div>`}
              <div class="tw-input" id="tw-modify" style="display:none">
                <label>自定义译名</label>
                <input id="tw-modify-input" placeholder="输入自定义译名…">
                <button class="tw-btn primary" id="tw-modify-ok">确认</button>
              </div>
            </div>
            <div class="tw-actions">
              ${isConfirm
                ? `<button class="tw-btn primary" id="tw-accept">${current.type === "voice" ? "确认画像 · 写入权威" : "确认为真 · 写入权威"}</button>`
                : `<button class="tw-btn primary" id="tw-accept" disabled>采用所选</button><button class="tw-btn" id="tw-modify-btn">自定义修改</button>`}
              <button class="tw-btn" id="tw-skip">跳过</button>
              <!-- 没有上一张就不摆这个按钮：队列常常只有一张卡（谐音梗/无译法词），
                   一个永远点不动的灰按钮只会让人反复去点，以为是坏了。 -->
              ${index === 0 ? "" : `<button class="tw-btn" id="tw-back">← 上一张</button>`}
              <button class="tw-btn" id="tw-manage-terms">管理术语表</button>
            </div>
          </div>
          <div class="tw-side">
            <div class="tw-side-title"><div><span class="tw-kicker">本书权威</span><h3>已确认术语</h3></div><span class="tw-progress">${confirmedTerms.length} 项</span></div>
            <div class="tw-side-list">${confirmedTerms.map((t) => `<div class="tw-side-row"><span><strong>${escapeHtml(t.ja)}</strong><small>${escapeHtml("术语")}</small></span><b>${escapeHtml(t.zh)}</b></div>`).join("") || `<div class="tw-side-empty">确认后的术语会出现在这里</div>`}</div>
          </div>
        </div>
      </div>`;
    bindProvisionalActions(panel, workspaceId, provisional);
    // 候选选中
    let selectedZh: string | undefined;
    const acceptBtn = document.getElementById("tw-accept");
    if (!isConfirm) {
      panel.querySelectorAll<HTMLElement>(".tw-cand").forEach((el) => {
        el.addEventListener("click", () => {
          panel.querySelectorAll<HTMLElement>(".tw-cand").forEach((e) => e.classList.remove("sel"));
          el.classList.add("sel");
          selectedZh = current.candidates?.[Number(el.dataset.i)]?.zh;
          if (acceptBtn) (acceptBtn as HTMLButtonElement).disabled = false;
        });
      });
    }
    const chosenVoiceCharacter = (): string | undefined => {
      if (current.type !== "voice") return undefined;
      const character = (document.getElementById("tw-voice-character") as HTMLInputElement | null)?.value.trim();
      if (!character) { runtimeWindow.showToast?.("请先指定说话者", { duration: 2600 }); document.getElementById("tw-voice-character")?.focus(); return ""; }
      return character;
    };
    let decisionBusy = false;
    /**
     * 一张卡只允许作出一次判定。
     *
     * 从前只有「确认」这颗按钮带锁，跳过/上一张/自定义确认三条路都是裸的；而判定成功后
     * 面板要靠一次异步重画才会换卡，那次重画又可能被竞态丢掉（见 renderConfirmedTerms 的
     * 泳道注释）。两件事凑一起就是：卡还在、还能点，点下去后端回一句「会话已结束」。
     *
     * 所以判定一旦发出就地封卡——重画到不到得了，这张卡都不能再被点第二次。
     */
    const lockCard = (): boolean => {
      if (decisionBusy) return false;
      decisionBusy = true;
      panel.querySelector<HTMLElement>(".tw-main")?.setAttribute("aria-busy", "true");
      panel.querySelectorAll<HTMLButtonElement>(".tw-main .tw-btn").forEach((button) => { button.disabled = true; });
      panel.querySelectorAll<HTMLElement>(".tw-cand").forEach((candidate) => { candidate.style.pointerEvents = "none"; });
      return true;
    };
    const unlockCard = (): void => {
      decisionBusy = false;
      panel.querySelector<HTMLElement>(".tw-main")?.removeAttribute("aria-busy");
      panel.querySelectorAll<HTMLButtonElement>(".tw-main .tw-btn").forEach((button) => { button.disabled = false; });
      panel.querySelectorAll<HTMLElement>(".tw-cand").forEach((candidate) => { candidate.style.pointerEvents = ""; });
    };
    acceptBtn?.addEventListener("click", () => {
      if (decisionBusy) return;
      const character = chosenVoiceCharacter();
      if (character === "") return;
      const voiceZh = current.type === "voice" ? (document.getElementById("tw-voice-zh") as HTMLInputElement | null)?.value.trim() ?? "" : undefined;
      const suggestedZh = current.candidates?.[0]?.zh;
      const action = current.type === "voice" && current.metadata?.selfRefJa && voiceZh !== (current.metadata?.selfRefZh ?? suggestedZh ?? "") ? "modify" : "accept";
      if (!lockCard()) return;
      acceptBtn.textContent = "正在写入…";
      void decideTerm(workspaceId, action, current.type === "voice" ? (voiceZh || suggestedZh) : selectedZh ?? suggestedZh, index, character).then((ok) => {
        if (ok) return;
        unlockCard();
        acceptBtn.textContent = current.type === "voice" ? "确认画像 · 写入权威" : "确认为真 · 写入权威";
      });
    });
    document.getElementById("tw-manage-terms")?.addEventListener("click", () => void renderConfirmedTerms(workspaceId));
    document.getElementById("tw-modify-btn")?.addEventListener("click", () => {
      const wrap = document.getElementById("tw-modify");
      if (!wrap) return;
      wrap.style.display = "flex";
      document.getElementById("tw-modify-input")?.focus();
    });
    document.getElementById("tw-modify-ok")?.addEventListener("click", () => {
      const input = document.getElementById("tw-modify-input") as HTMLInputElement | null;
      const text = input?.value.trim();
      if (!text) return;
      const character = chosenVoiceCharacter();
      if (character === "") return;
      if (!lockCard()) return;
      void decideTerm(workspaceId, "modify", text, index, character).then((ok) => { if (!ok) unlockCard(); });
    });
    document.getElementById("tw-skip")?.addEventListener("click", () => {
      if (!lockCard()) return;
      void decideTerm(workspaceId, "skip", undefined, index).then((ok) => { if (!ok) unlockCard(); });
    });
    document.getElementById("tw-back")?.addEventListener("click", () => {
      if (!lockCard()) return;
      void decideTerm(workspaceId, "back", undefined, index).then((ok) => { if (!ok) unlockCard(); });
    });
  }
  // 更新术语 tab badge（真实待确认数）
  /** 术语提取是否进行中（由 agent.status 驱动；仅影响呈现，不参与任何写入判定） */
  let termExtracting = false;

  async function updateTermBadge(workspaceId: string): Promise<void> {
    const token = workbenchContext.capture("workspace", "term-badge");
    const api = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<{ ok: boolean; value?: { status: { status: string; pendingCount?: number } } }> } }).lightee;
    const list = await api?.invoke("confirm.list", { workspaceId });
    if (!workbenchContext.accepts(token) || activeWorkspace?.id !== workspaceId || !list?.ok) return;
    // ADR-0008 两来源一队列：徽标计数 = 确认卡 + 档案暂定（provenance=model）。
    // 只数卡片的话，登记即注入的词条在徽标上是隐形的——终审队列看起来永远是空的。
    const provisionalCount = (await queryProvisionalTerms(workspaceId)).items.length;
    if (!workbenchContext.accepts(token) || activeWorkspace?.id !== workspaceId) return;
    const pending = (list.value?.status?.pendingCount ?? 0) + provisionalCount;
    // demo 让位后这两处无人填（见 ui-shell-runtime 的 lighteeReal）——由这里按真实计数接管。
    // 只挡住 demo 而不接管，等于把「错的数字」换成「空白」，那不算修好。
    const status = list.value?.status?.status ?? "not-extracted";
    // 三态判定见 terminology-view.ts：从未提取时待确认自然是 0，
    // 压成两态就会把它显示成 ✓（对勾旁边写着「未开始」正是这么来的）。
    const badgeView = termBadgeView(termExtracting ? "extracting" : status, pending);
    document.querySelectorAll<HTMLElement>("[data-btab=\"terms\"] .workflow-tab-badge").forEach((badge) => {
      badge.textContent = badgeView.text;
      badge.title = badgeView.title;
      badge.classList.toggle("warn", badgeView.tone === "warn");
      badge.classList.toggle("busy", badgeView.tone === "busy");
      badge.classList.toggle("idle", badgeView.tone === "idle");
      // ok 也要显式给：绿色从前靠 `:not(.warn)` 兜底，等于把「没有待办」一律染成完成色
      badge.classList.toggle("ok", badgeView.tone === "ok");
    });
    const link = document.getElementById("terms-link");
    if (link) {
      link.classList.toggle("warn", pending > 0);
      link.classList.toggle("ok", pending === 0 && status === "confirmed");
      link.textContent = pending > 0 ? `待确认 ${pending}` : status === "confirmed" ? "术语已确认" : "尚未扫描";
    }
    const zone = document.getElementById("pending-zone");
    if (zone) {
      zone.classList.toggle("complete", pending === 0 && status === "confirmed");
      const head = zone.querySelector(".pz-head");
      const summary = zone.querySelector(".pz-summary");
      const label = pending > 0 ? "术语确认" : status === "confirmed" ? "术语已确认" : "术语尚未扫描";
      if (head) head.innerHTML = `<span><b>下一步</b> · ${label}${pending > 0 ? ` <span id="pz-count" style="color:var(--yellow)">${pending}</span>` : ""}</span><span class="pz-enter">${pending > 0 ? "开始处理 →" : "查看术语表 →"}</span>`;
      if (summary) summary.textContent = pending > 0 ? "整章翻译前必须完成本章候选术语确认" : status === "confirmed" ? "整章翻译可以开始" : "先运行术语扫描";
    }
  }

  function updateRealStatusBar(): void {
    const workspace = activeWorkspace;
    if (!workspace) return;
    const chapters = workspace.volumes.flatMap((volume) => volume.chapters);
    // 页脚三格常驻状态已删（作者裁定 2026-08-13）：「N 已译」「已就绪」这类
    // 复述的是章节树与上方进度条已经说过的话，占着页脚却不新增任何判断依据。
    // 现在这里只剩章节相位：demo 用它自己的 chapterPhase 画，真实值只有当前章节的 state 说了算
    const phaseLabel = document.getElementById("chapter-phase-label");
    if (phaseLabel) {
      const current = chapters.find((chapter) => chapter.id === activeChapterContent?.chapterId);
      const labels: Record<string, string> = {
        imported: "未开始", ready: "等待翻译", translating: "翻译中", translated: "待审校",
        reviewing: "审校中", revising: "修订中", approved: "已批准", stuck: "已熔断",
      };
      phaseLabel.textContent = current?.state ? labels[current.state] ?? current.state : "—";
    }
  }

  /**
   * 主按钮换文案时的形变动画：旧字**先缩回去**，宽度跟着新文案伸展，新字再落回来。
   *
   * 为什么值得做：这颗按钮的文案变化本身就是状态变化的信号（开始翻译 → 跑批中 3/12 →
   * ✓ 已完成），而文案长度差得很远。直接改 textContent 的话按钮会瞬间跳一个宽度，
   * 旁边的「本章检查」「导出」被顶得一抖——读者只看见抖动，看不见「它换了状态」。
   * 让宽度自己走过去，变化就成了可读的动作。
   *
   * 用 Web Animations API 而不是加类名：动画状态跟着元素走，中途再次改文案时
   * 直接被下一次 animate 接管，不会留下半路的类名把按钮卡在透明状态。
   */
  function morphMainAct(btn: HTMLElement, text: string): void {
    if (btn.textContent === text) return;
    // 系统级「减少动态效果」是无障碍设置，不是偏好——直接换字
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || typeof btn.animate !== "function") {
      btn.textContent = text;
      return;
    }
    const from = btn.getBoundingClientRect().width;
    btn.animate(
      [{ opacity: 1, transform: "translateY(0)", filter: "blur(0px)" }, { opacity: 0, transform: "translateY(-3px)", filter: "blur(2px)" }],
      { duration: 110, easing: "cubic-bezier(.4,0,1,1)" },
    ).finished.then(() => {
      btn.textContent = text;
      btn.style.width = "";
      const to = btn.getBoundingClientRect().width;
      // 宽度差不到 1px 就别演了——原地闪一下比不动更碍眼
      if (Math.abs(to - from) >= 1) {
        btn.animate([{ width: `${from}px` }, { width: `${to}px` }], { duration: 260, easing: "cubic-bezier(.2,.9,.3,1)" });
      }
      btn.animate(
        [{ opacity: 0, transform: "translateY(3px)", filter: "blur(2px)" }, { opacity: 1, transform: "translateY(0)", filter: "blur(0px)" }],
        { duration: 190, easing: "cubic-bezier(.16,1,.3,1)" },
      );
    }).catch(() => { btn.textContent = text; });
  }

  // ===== Footer 主按钮真实化：按当前章节状态 + 术语状态驱动（替代 demo「先处理术语」） =====
  async function updateMainActButton(preferredChapterId?: string): Promise<void> {
    const btn = document.getElementById("main-act-btn");
    if (!btn || !activeWorkspace) return;
    const token = workbenchContext.capture("workspace", "main-action");
    const workspace = activeWorkspace;
    const all = workspace.volumes.flatMap((volume) => volume.chapters);
    const chapter = all.find((item) => item.id === (preferredChapterId ?? activeChapterContent?.chapterId)) ?? all[0];
    // 术语状态（confirm.list）
    const api = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<{ ok: boolean; value?: { status?: { status?: string; pendingCount?: number } } }> } }).lightee;
    let termStatus = "not-extracted";
    let pending = 0;
    const list = await api?.invoke("confirm.list", { workspaceId: workspace.id });
    // acceptsLane 而不是 accepts——与侧栏术语表同一个坑：主按钮是**工作区级**效果，
    // 但 accepts 只要代次变了就作废，而挂载序列恰好是「更新主按钮 → 打开上次编辑的章节」，
    // 后者推进代次，confirm.list 回来时这次更新已被整个丢弃。
    // 于是 dataset.owner 从没被标上，按钮一直停在 HTML 里那句写死的默认文案。
    if (!workbenchContext.acceptsLane(token)) return;
    if (list?.ok) {
      termStatus = list.value?.status?.status ?? "not-extracted";
      pending = list.value?.status?.pendingCount ?? 0;
    }
    const set = (text: string, onClick?: () => void, title = "", running = false): void => {
      // 所有权声明（RH-12 / design/renderer-dom-ownership.md §2）：`#main-act-btn` 由 bridge 独占。
      // ui-shell-runtime 的 syncWorkflowUI 见到这个标记就整段让位——它按 demo 的 chapterPhase
      // 算文案，在真实工作区里会把「开始翻译」覆盖回「先处理术语」并把 onclick 换成 demo 的
      // startTranslate（RH-16 实测：术语已确认、章节 imported 时主按钮仍显示「先处理术语」，
      //「⏹ 停止」出口因此在 UI 上不可达）。
      // 用 dataset 标记而不是新开 window.__lightee* 全局：§4 已冻结挂载点清单。
      btn.dataset.owner = "bridge";
      morphMainAct(btn, text);
      btn.onclick = onClick ?? (() => {});
      if (title) btn.title = title;
      btn.classList.toggle("blocked", !onClick);
      // 跑批中：按钮自己持续表态，不必去别处确认「它到底动没动」
      btn.classList.toggle("is-running", running);
    };
    // RS-2：跑批进行中主按钮显示 k/N 并把人带去命令栏（停止的两段式档位在那里）
    if (scopeInvokePending || scopeRun) {
      const position = scopeRun && scopeRun.index > 0 ? ` ${scopeRun.index}/${scopeRun.total}` : "…";
      set(`工作中${position}`, () => { document.querySelector<HTMLElement>("[data-btab=\"agent\"]")?.click(); }, "工作中——查看进度或停止（Agent 控制台）", true);
      return;
    }
    if (!chapter) {
      set("新建章节", () => { const el = document.querySelector<HTMLElement>("[data-action=\"new-chapter\"]"); if (el) el.click(); }, "工作区还没有章节");
      return;
    }
    if (chapter.state === "approved" || chapter.state === "translated") {
      set("✓ 已完成", () => { document.querySelector<HTMLElement>(`.item[data-cid="${chapter.id}"]`)?.click(); }, "本章已完成翻译");
    } else if (chapter.state === "translating" || chapter.state === "reviewing" || chapter.state === "revising") {
      // RH-16：长任务必须有出口——「处理中…」不再是死按钮
      set("⏹ 停止", () => void cancelAiTranslate(chapter.id), "取消本章的翻译/审校（状态回到待翻译）", true);
    } else if (termStatus === "pending") {
      // EX-07：待确认的词不再挡住翻译，但它是主按钮里更值得先做的一件事——
      // 定了译法，后面章节才会沿用；点进去也随时能直接开翻。
      set(`术语确认 ${pending}`, () => document.querySelector<HTMLElement>("[data-btab=\"terms\"]")?.click(), "有新词待确认（不影响继续翻译）");
    } else {
      // EX-07：「扫描术语」分支退役——译前提取阶段不存在了，导入即可翻。
      // RS-2：入口只发意图——跳 Agent 控制台命令栏，范围可见、可改，再按开始。
      set("开始翻译", () => openTranslateComposer(), "选择范围并开始翻译（Agent 控制台）");
    }
  }

  // ===== 侧栏真实化：术语表（真实术语）+ 进度/token（真实统计） =====
  async function renderSideTerms(): Promise<void> {
    if (!activeWorkspace) return;
    const token = workbenchContext.capture("workspace", "side-terms");
    const workspaceId = activeWorkspace.id;
    const terms = await adapter.queryTerms(workspaceId);
    // 用 acceptsLane 而不是 accepts：侧栏术语是工作区级数据，换一章跟它无关。
    // 挂载序列是「发起查询 → 打开上次编辑的章节」，后者推进代次，accepts 会在写入前
    // 把这次渲染整个丢掉；真实应用的骨架里这块是空的，于是术语表永远空白且不报错。
    if (!workbenchContext.acceptsLane(token)) return;
    const countEl = document.getElementById("terms-count");
    const body = document.getElementById("terms-body");
    const mini = document.getElementById("terms-pending-mini");
    // 空列表要说清「为什么空」：从未扫描、正在扫描、确实没有，是三件事。
    // 只留一句「暂无已确认术语」，用户无从判断该等待还是该去点扫描。
    const termStatus = termExtracting ? "extracting" : terms.length ? "confirmed" : "not-extracted";
    if (countEl) countEl.textContent = terms.length ? String(terms.length) : "—";
    if (mini) mini.textContent = terms.length ? "已确认" : termExtracting ? "扫描中" : "未扫描";
    if (body) {
      body.innerHTML = terms.length
        ? terms.slice(0, 40).map((term) => `<div class="term-mini-row"><span class="tm-ja">${escapeHtml(term.ja)}</span><b>${escapeHtml(term.zh)}</b></div>`).join("")
        : `<div class="term-mini-empty">${escapeHtml(termListEmptyText(termStatus))}</div>`;
    }
  }
  async function updateSideFoot(): Promise<void> {
    if (!activeWorkspace) return;
    const token = workbenchContext.capture("workspace", "side-foot");
    const chapters = activeWorkspace.volumes.flatMap((volume) => volume.chapters);
    const total = chapters.length;
    const done = chapters.filter((chapter) => chapter.state === "approved" || chapter.state === "translated").length;
    const translating = chapters.filter((chapter) => chapter.state === "translating" || chapter.state === "reviewing" || chapter.state === "revising").length;
    const pct = total ? Math.round(((done + translating) / total) * 100) : 0;
    const text = document.getElementById("side-progress-text");
    const bar = document.getElementById("side-progress-bar");
    if (text) text.textContent = translating > 0 ? `${done}/${total} · ${translating} 章进行中` : `${done}/${total} · ${pct}%`;
    if (bar) {
      bar.style.width = `${pct}%`;
      // 有章节在跑就让条纹流动：动起来的东西本身就是"没卡死"的信号，静止即空闲
      bar.classList.toggle("working", translating > 0);
    }
    // token：真实 LLM 用量（input+output 累计）
    const lightee = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<{ ok: boolean; value?: { totals?: { input: number; output: number }; entries?: Array<{ model?: string; ok?: boolean }> } }> } }).lightee;
    const result = await lightee?.invoke("agent.log.list", { limit: 1 });
    if (!workbenchContext.accepts(token)) return;
    // 标题栏绿灯的「证据」不只来自设置页的测试连接：任何一次真实调用的结论都算数。
    // 此前只有测试按钮回填 lastProbe——用户翻译成功了灯还是灰的，被当成「没配好」。
    const newest = result?.ok ? result.value?.entries?.[0] : undefined;
    if (newest?.model && (lastProbe?.model !== newest.model || lastProbe?.ok !== (newest.ok === true))) {
      recordProbe({ ok: newest.ok === true, model: newest.model });
    }
    const totals = result?.ok ? result.value?.totals : undefined;
    const tokenEl = document.getElementById("m-token");
    const tokenText = totals ? (totals.input + totals.output).toLocaleString() : "0";
    if (tokenEl) tokenEl.textContent = tokenText;
    // footer 的 token 与侧栏同源。此前它由 SIM 模拟器每秒递增，是纯粹的假数字。
    const footerToken = document.getElementById("sys-token");
    if (footerToken) footerToken.textContent = tokenText;
  }

  // ===== 原文编辑视图（原文可编辑开关开启时，从 note 栏「✎ 编辑原文」进入）=====
  let sourceEditRevision = 0;
  async function openSourceEditor(): Promise<void> {
    if (!activeWorkspace || !activeChapterContent) return;
    const workspaceId = activeWorkspace.id;
    const chapterId = activeChapterContent.chapterId;
    if (!await leaveEditorSession()) return;
    if (activeWorkspace?.id !== workspaceId || activeChapterContent?.chapterId !== chapterId) return;
    transitionContext(workspaceId, chapterId, "bi");
    const token = workbenchContext.capture("chapter", "source-editor");
    const panel = document.getElementById("bpanel");
    if (!panel) return;
    panel.innerHTML = `<div class="ws-editor-loading" aria-live="polite">正在读取原文…</div>`;
    const loaded = await adapter.loadChapter(workspaceId, chapterId);
    if (!workbenchContext.accepts(token)) return;
    if (!loaded.ok) {
      panel.innerHTML = `<div class="ws-editor-error" role="alert"><strong>原文加载失败</strong><span>${escapeHtml(loaded.message)}</span><button type="button" id="source-edit-back">返回译文</button></div>`;
      document.getElementById("source-edit-back")?.addEventListener("click", () => void openChapterSafely(workspaceId, chapterId));
      runtimeWindow.pushEvent?.(`原文加载失败：${loaded.message}`, "err");
      return;
    }
    const sourceText = loaded.content.paragraphs.map((paragraph) => paragraph.source).join("\n\n");
    sourceEditRevision = loaded.content.sourceCorrectionRevision;
    panel.innerHTML = `
      <div class="continuous-editor-shell" style="height:100%;min-height:0;display:flex;flex-direction:column">
        <div class="continuous-editor-note">
          <span class="editor-context"><strong>原文编辑</strong><span class="note-divider">/</span><span>${escapeHtml(chapterId)}</span></span>
          <span style="display:inline-flex;align-items:center;gap:10px">
            <span class="editor-status"><span class="status-dot"></span> 日文原文 · 覆盖保存</span>
            <button class="toggle-src" id="src-edit-back" type="button">↩ 返回译文</button>
          </span>
        </div>
        <div style="flex:1;min-height:0;display:flex;flex-direction:column;padding:16px 28px">
          <textarea id="source-edit-area" class="source-edit-area" spellcheck="false" placeholder="粘贴本段日文原文…（段落之间空一行）"></textarea>
        </div>
        ${editorFootBar({
          chapterId,
          meta: "覆盖保存",
          stateId: "src-edit-hint",
          stateLabel: "无改动",
          keys: [{ keys: ["Ctrl", "Enter"], label: "保存" }],
        })}
      </div>`;
    const area = document.getElementById("source-edit-area") as HTMLTextAreaElement | null;
    if (area) area.value = sourceText;
    const hint = document.getElementById("src-edit-hint");
    const backBtn = document.getElementById("src-edit-back");
    const sourceController = new SourceCorrectionController({
      adapter: {
        saveSourceCorrection: async (request) => {
          const result = await adapter.saveSourceCorrection(request.workspaceId, request.chapterId, request.baseRevision, request.source);
          return result.ok ? { ok: true, revision: result.revision } : { ok: false, code: result.code, revision: result.revision };
        },
      },
      workspaceId,
      chapterId,
      delayMs: 1000,
      onStateChange: (state) => {
        if (!workbenchContext.accepts(token) || sourceEditorSession?.controller !== sourceController || !hint) return;
        const labels: Record<AutosaveState["phase"], string> = { idle: "无改动", modified: "编辑中…", saving: "保存中…", saved: "原文已保存", failed: "原文保存失败", conflict: "原文版本冲突" };
        // 这一格从前只写文案不写 tone，于是「原文保存失败」沿用默认色照样是绿的
        const tones: Record<AutosaveState["phase"], string> = { idle: "idle", modified: "busy", saving: "busy", saved: "ok", failed: "error", conflict: "error" };
        hint.textContent = labels[state.phase];
        hint.dataset.tone = tones[state.phase];
      },
    });
    sourceController.reset(sourceEditRevision);
    sourceEditorSession = { workspaceId, chapterId, token, controller: sourceController };
    const saveSource = async (): Promise<boolean> => {
      await sourceController.flush();
      const state = sourceController.getState();
      return state.phase !== "failed" && state.phase !== "conflict";
    };
    if (area) {
      area.addEventListener("input", () => sourceController.markModified(area.value));
      area.addEventListener("keydown", (event) => {
        if (event.ctrlKey && event.key === "Enter") { event.preventDefault(); void saveSource(); }
      });
    }
    backBtn?.addEventListener("click", () => {
      void saveSource().then((saved) => {
        if (!saved || !workbenchContext.accepts(token)) return;
        sourceController.dispose();
        if (sourceEditorSession?.controller === sourceController) sourceEditorSession = null;
        void openChapterSafely(workspaceId, chapterId);
      });
    });
    area?.focus();
  }

  // ===== 空原文章节引导（章节只有标题、无正文原文时显示）=====
  function renderEmptySourceGuide(panel: HTMLElement, chapterId: string): void {
    panel.innerHTML = `
      <div class="ws-empty-guide">
        <div class="ws-empty-title">这个章节还没有日文原文</div>
        <div class="ws-empty-sub">粘贴原文后即可开始对照翻译</div>
        <div class="ws-empty-actions">
          <button type="button" class="ws-empty-btn primary" id="src-empty-paste">${uiIcon("clipboard")}粘贴日文原文</button>
          <button type="button" class="ws-empty-btn" id="src-empty-file">${uiIcon("file")}打开文件…</button>
        </div>
        <div class="ws-empty-hint">${escapeHtml(chapterId)} · 文件导入按整本切章，会新建章节而不是填进本章</div>
      </div>`;
    const pasteBtn = document.getElementById("src-empty-paste");
    if (pasteBtn) pasteBtn.onclick = () => void openSourceEditor();
    const fileBtn = document.getElementById("src-empty-file");
    // 从前这里只弹一句「请拖入左侧栏」——按钮什么都不做，而那句话还教错了操作。
    // 现在走和空工作区引导同一条真实通道：选文件 → 导入面板。
    if (fileBtn) fileBtn.onclick = () => void importFromPicker();
  }

  /**
   * 线框小图标。图标集与 `.ui-icon` 样式都住在原型运行时里（设置面板一直在用），
   * 这里只是把同一套取过来用——不重画一份，两处走形是迟早的事。
   * 运行时还没挂上时返回空串：按钮少一个图标不影响它能按。
   */
  function uiIcon(name: string): string {
    const draw = (runtimeWindow as BridgeWindow & { icon?: (name: string) => string }).icon;
    return typeof draw === "function" ? draw(name) : "";
  }

  /**
   * 打开导入面板。`mode` 决定落在哪个页签：`file` 是选好文件之后的预览，
   * `paste` 是直接粘正文。
   *
   * 从前「粘贴文本」按钮只弹一句「从设计稿入口进入」的提示就完事——按钮写着一个
   * 动作却不做那个动作，用户看到的就是「点了没反应」。
   */
  function openImportPreview(mode: "file" | "paste"): void {
    const open = (runtimeWindow as BridgeWindow & { importPreview?: (mode?: string) => void }).importPreview;
    if (typeof open === "function") {
      open(mode);
      return;
    }
    runtimeWindow.showToast?.("导入面板还没准备好，请稍后重试", { duration: 2600 });
  }

  // ===== 空工作区导入引导：帮助建立首个章节 =====
  function renderEmptyWorkspaceGuide(panel: HTMLElement): void {
    panel.innerHTML = `
      <div class="ws-empty-guide">
        <div class="ws-empty-title">把小说拖进来，开始翻译</div>
        <div class="ws-empty-sub">支持 TXT / MD / EPUB · 自动分章 · 分卷识别</div>
        <div class="ws-empty-actions">
          <button type="button" class="ws-empty-btn primary" id="ws-empty-open">${uiIcon("file")}打开文件…</button>
          <button type="button" class="ws-empty-btn" id="ws-empty-paste">${uiIcon("clipboard")}粘贴文本</button>
        </div>
        <div class="ws-empty-hint">也可以把文件拖到左侧栏</div>
      </div>`;
    const openBtn = document.getElementById("ws-empty-open");
    if (openBtn) openBtn.onclick = () => void importFromPicker();
    const pasteBtn = document.getElementById("ws-empty-paste");
    if (pasteBtn) pasteBtn.onclick = () => openImportPreview("paste");
  }

  /**
   * 打开文件导入。
   *
   * 从前这里自己弹一次文件选择框，拿到路径 `pushEvent` 一下就**扔了**，然后才打开导入面板；
   * 而 `importPreview()` 一进门就把 `importSourcePath` 清空。于是必然是：选完文件，
   * 面板空白地弹出来，什么都没导入。
   *
   * 面板本身有一条完整的「选文件 → import.preview → 渲染预览」链（`importPickFile`），
   * 路径也归它管。这里不再自己选，只负责把面板开到文件页签再把选择权交回去——
   * 对话框只弹一次，路径始终只有一个主人。
   */
  async function importFromPicker(): Promise<void> {
    openImportPreview("file");
    const pick = (runtimeWindow as BridgeWindow & { importPickFile?: () => Promise<void> }).importPickFile;
    if (typeof pick !== "function") return;
    await pick();
  }

  function renderChapterList(workspace: WorkspaceRecord): string {
    // 当前卷高亮在**渲染时**打进 HTML：树重渲染（导入/改名/删章）会整段替换 innerHTML，
    // 只靠点击时补 class 的话，任何一次刷新都会把高亮抹掉。
    const activeVolumeId = currentVolumeId(workspace.volumes, activeChapterContent?.chapterId ?? null);
    const volumes = workspace.volumes.map((volume) => {
      const done = volume.chapters.filter((chapter) => chapter.state === "approved" || chapter.state === "translated").length;
      const chapters = volume.chapters.map((chapter) => `
        <div class="item" role="button" tabindex="0" data-cid="${escapeHtml(chapter.id)}" data-vol="${escapeHtml(volume.id)}">
          <span class="drag-grip" title="拖拽排序">⠿</span>
          <!-- 飞行中的状态点会呼吸：这一列同时承载「已完成/待翻译/正在翻译」三类状态，
               静止的圆点分不出「正在动」和「停在这儿」——而这恰恰是作者最想一眼看到的。 -->
          <span class="ch-state-mark${isInFlightState(chapter.state) ? " live" : ""}" style="color:${chapterStateColor(chapter.state)};font-size:11px">${chapterStateIcon(chapter.state)}</span>
          <span class="it-title">${escapeHtml(chapter.title)}</span>
          <span class="ch-edit" title="改章名" data-action="edit-chapter">✎</span>
          <span class="ch-del" title="删除章节" data-action="delete-chapter">删</span>
          <span class="st" style="color:${chapterStateColor(chapter.state)}">${chapterStateLabel(chapter.state)}</span>
        </div>`).join("");
      return `
        <div class="vol-head${volume.id === activeVolumeId ? " current-vol" : ""}" role="button" tabindex="0" data-vol="${escapeHtml(volume.id)}">
          <span class="arrow">▶</span>
          <span style="font-size:10px;color:var(--dimmer)">${escapeHtml(volume.id)}</span>
          <span class="vol-title">${escapeHtml(volume.name)}</span>
          <span class="vol-edit" title="改卷名" data-action="edit-volume">✎</span>
          <span class="vol-new" title="新建章节" data-action="new-chapter">＋</span>
          <span class="vol-del" title="删除卷" data-action="delete-volume">删</span>
          <span style="font-size:10px;color:var(--dimmer)">${done}/${volume.chapters.length} 已译</span>
        </div>
        <div class="vol-body open" data-vol="${escapeHtml(volume.id)}"><div>${chapters}</div></div>`;
    }).join("");
    return `<div class="book-meta">${escapeHtml(workspace.name)} · ${escapeHtml(workspace.path)}</div>${volumes}`;
  }

  function bindVolumeToggles(): void {
    const list = document.getElementById("chapter-list");
    if (!list) return;
    list.addEventListener("click", (event) => {
      const actionEl = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
      if (actionEl) {
        const action = actionEl.dataset.action;
        if (action === "edit-chapter") { event.stopPropagation(); void beginInlineEdit("chapter", actionEl); return; }
        if (action === "edit-volume") { event.stopPropagation(); void beginInlineEdit("volume", actionEl); return; }
        if (action === "new-chapter") { event.stopPropagation(); void createChapter(actionEl.closest<HTMLElement>("[data-vol]")?.dataset.vol ?? ""); return; }
        if (action === "delete-chapter") { event.stopPropagation(); void deleteChapter(actionEl.closest<HTMLElement>("[data-vol]")?.dataset.vol ?? "", actionEl.closest<HTMLElement>("[data-cid]")?.dataset.cid ?? "", actionEl); return; }
        if (action === "delete-volume") { event.stopPropagation(); void deleteVolume(actionEl.closest<HTMLElement>("[data-vol]")?.dataset.vol ?? "", actionEl); return; }
      }
      // 卷折叠
      const head = (event.target as HTMLElement).closest<HTMLElement>(".vol-head");
      if (head) {
        const volumeId = head.dataset.vol;
        const body = [...document.querySelectorAll<HTMLElement>("[data-vol]")].find((node) => node.dataset.vol === volumeId && node.classList.contains("vol-body"));
        if (body) {
          const wasOpen = body.classList.contains("open");
          body.classList.toggle("open", !wasOpen);
          head.querySelector(".arrow")?.classList.toggle("closed", wasOpen);
          // 卷收起/展开后：只做动画结束后的校正（grid 280ms 过渡结束、位置稳定）
          // 不做 60ms 快速校正——动画中位置未定，滑到中间会形成「错位等待→延迟贴回」
          setTimeout(() => runtimeWindow.moveCursor?.(), 320);
        }
        return;
      }
      // 章节 item 点击 → 打开章节 + 加载真实内容（跳过编辑中）
      const item = (event.target as HTMLElement).closest<HTMLElement>(".item[data-cid]");
      if (item && !item.classList.contains("editing")) {
        const chapterId = item.dataset.cid;
        if (chapterId && typeof runtimeWindow.openChapter === "function") {
          void (async () => {
            if (!activeWorkspace) return;
            const workspaceId = activeWorkspace.id;
            if (!await leaveEditorSession()) return;
            if (activeWorkspace?.id !== workspaceId) return;
            runtimeWindow.openChapter?.(chapterId);
            restoreTabSelection("bi");
            await openChapterSafely(workspaceId, chapterId);
            ensureEditorInvariant("chapter-click");
            void updateMainActButton(chapterId);
            runtimeWindow.moveCursor?.();
            setTimeout(() => runtimeWindow.moveCursor?.(), 60);
            setTimeout(() => runtimeWindow.moveCursor?.(), 320);
          })();
        }
      }
    });
    bindTreeDrag(list);
  }

  // ===== 内联编辑标题（Enter 保存 / Escape 取消 / blur 自动保存）=====
  async function beginInlineEdit(kind: "chapter" | "volume", btn: HTMLElement): Promise<void> {
    if (!activeWorkspace) return;
    const workspaceId = activeWorkspace.id;
    const host = btn.closest<HTMLElement>(".vol-head,.item");
    const titleEl = btn.previousElementSibling as HTMLElement | null;
    if (!host || !titleEl || titleEl.tagName === "INPUT") return;
    const id = kind === "volume" ? host.dataset.vol ?? "" : host.dataset.cid ?? "";
    const current = titleEl.textContent?.replace(/◈/g, "").trim() ?? "";
    host.classList.add("editing");
    const input = document.createElement("input");
    input.className = "ed-sim";
    input.value = current;
    input.onclick = (e) => e.stopPropagation();
    const commit = async () => {
      if (input.dataset.done) return;
      input.dataset.done = "1";
      const value = input.value.trim();
      if (value && value !== current) {
        const ok = kind === "volume"
          ? await adapter.renameVolume(workspaceId, id, value)
          : await adapter.renameChapter(workspaceId, host.dataset.vol ?? "", id, value);
        runtimeWindow.pushEvent?.(ok ? `✓ ${kind === "volume" ? "卷名" : "章名"}已更新` : "重命名失败", ok ? "ok" : "err");
      }
      if (activeWorkspace?.id === workspaceId) await refreshTree();
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); void commit(); }
      else if (e.key === "Escape") { e.preventDefault(); input.dataset.done = "1"; void refreshTree(); }
    };
    input.onblur = () => void commit();
    btn.style.display = "none";
    titleEl.replaceWith(input);
    input.focus();
    input.select();
  }

  // ===== 新建章节（Obsidian：＋ → 内联标题 → 刷新）=====
  // ===== 新建章节（对话框：章节名 + 可选的日文原文）=====
  async function createChapter(volumeId: string): Promise<void> {
    if (!activeWorkspace) return;
    const workspaceId = activeWorkspace.id;
    // 模态对话框：章节名 + 日文原文（A 方案——可一次性贴入整章原文）
    const overlay = document.createElement("div");
    overlay.className = "nc-modal-overlay";
    overlay.innerHTML = `
      <div class="nc-modal">
        <div class="nc-modal-head">新建章节</div>
        <label class="nc-field"><span>章节名</span><input id="nc-title" class="nc-input" type="text" placeholder="如：第4章 …" value="新章节" /></label>
        <label class="nc-field"><span>日文原文（可选）</span><textarea id="nc-source" class="nc-input nc-textarea" placeholder="粘贴本段日文原文…\n留空则只创建章节标题"></textarea></label>
        <div class="nc-modal-actions">
          <button type="button" class="nc-btn" id="nc-cancel">取消</button>
          <button type="button" class="nc-btn primary" id="nc-confirm">创建</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const titleInput = overlay.querySelector<HTMLInputElement>("#nc-title");
    const sourceInput = overlay.querySelector<HTMLTextAreaElement>("#nc-source");
    const confirmBtn = overlay.querySelector<HTMLElement>("#nc-confirm");
    const cancelBtn = overlay.querySelector<HTMLElement>("#nc-cancel");
    const close = () => overlay.remove();
    const doCreate = async () => {
      const title = titleInput?.value.trim() || "新章节";
      const source = sourceInput?.value ?? "";
      const result = await adapter.createChapter(workspaceId, volumeId, title, undefined, source.trim() ? source.trim() : undefined);
      if (!result.ok) { runtimeWindow.pushEvent?.(`新建章节失败：${result.message}`, "err"); return; }
      close();
      if (activeWorkspace?.id !== workspaceId) return;
      await refreshTree();
      void updateMainActButton();
      runtimeWindow.pushEvent?.(`＋ 已新建章节《${result.title}》`, "ok");
      // 新建后打开该章节（若有原文则直接进入编辑器；无原文显示空章节引导）
      const item = document.querySelector<HTMLElement>(`.item[data-cid="${result.chapterId}"]`);
      item?.click();
    };
    confirmBtn?.addEventListener("click", () => void doCreate());
    cancelBtn?.addEventListener("click", close);
    overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
    titleInput?.focus();
    titleInput?.select();
  }

  // ===== 删除章节（防误删：已译章确认？+ 活动流撤销）=====
  let confirmingDelete: { key: string; timer: number } | null = null;
  async function deleteChapter(volumeId: string, chapterId: string, button: HTMLElement): Promise<void> {
    if (!activeWorkspace) return;
    const chapter = activeWorkspace.volumes.find((volume) => volume.id === volumeId)?.chapters.find((candidate) => candidate.id === chapterId);
    const isTranslated = chapter?.state === "approved" || chapter?.state === "translated" || chapter?.state === "translating" || chapter?.state === "reviewing" || chapter?.state === "revising";
    const key = `${volumeId}/${chapterId}`;
    if (isTranslated && !button.classList.contains("confirm")) {
      button.classList.add("confirm");
      button.textContent = "确认？";
      if (confirmingDelete) clearTimeout(confirmingDelete.timer);
      confirmingDelete = { key, timer: window.setTimeout(() => { button.classList.remove("confirm"); button.textContent = "删"; if (confirmingDelete?.key === key) confirmingDelete = null; }, 2600) };
      return;
    }
    button.classList.remove("confirm");
    button.textContent = "删";
    const workspaceId = activeWorkspace.id;
    const deletingActiveChapter = activeChapterContent?.workspaceId === workspaceId && activeChapterContent.chapterId === chapterId;
    if (deletingActiveChapter && !await flushEditorSession()) return;
    const result = await adapter.deleteChapter(workspaceId, volumeId, chapterId);
    if (!result.ok) { runtimeWindow.pushEvent?.(`删除失败：${result.message}`, "err"); return; }
    if (activeWorkspace?.id === workspaceId) await refreshTree();
    // 活动流撤销（无时间限制，调 restore）
    const trashId = result.trashId;
    runtimeWindow.pushEvent?.(`已删除章节《${result.title}》 <span class="ev-undo" data-action="undo" data-undo-id="${trashId}" data-undo-kind="chapter" data-undo-workspace="${workspaceId}">↩ 撤回</span>`, "err");
    showUndoToast(`已删除章节《${result.title}》`, () => void restoreChapter(workspaceId, trashId));
  }

  async function restoreChapter(workspaceId: string, trashId: string): Promise<void> {
    const result = await adapter.restoreChapter(workspaceId, trashId);
    if (!result.ok) { runtimeWindow.pushEvent?.(`恢复失败：${result.message}`, "err"); return; }
    if (activeWorkspace?.id === workspaceId) await refreshTree();
    runtimeWindow.pushEvent?.("↩ 已恢复章节", "ok");
  }

  // ===== 删除卷（二次确认 + 撤销）=====
  async function deleteVolume(volumeId: string, button: HTMLElement): Promise<void> {
    if (!activeWorkspace) return;
    const key = `vol/${volumeId}`;
    if (!button.classList.contains("confirm")) {
      button.classList.add("confirm");
      button.textContent = "确认？";
      if (confirmingDelete) clearTimeout(confirmingDelete.timer);
      confirmingDelete = { key, timer: window.setTimeout(() => { button.classList.remove("confirm"); button.textContent = "删"; if (confirmingDelete?.key === key) confirmingDelete = null; }, 2600) };
      return;
    }
    button.classList.remove("confirm");
    button.textContent = "删";
    const workspaceId = activeWorkspace.id;
    const volume = activeWorkspace.volumes.find((candidate) => candidate.id === volumeId);
    const deletingActiveChapter = Boolean(activeChapterContent && volume?.chapters.some((chapter) => chapter.id === activeChapterContent!.chapterId));
    if (deletingActiveChapter && !await flushEditorSession()) return;
    const result = await adapter.deleteVolume(workspaceId, volumeId);
    if (!result.ok) { runtimeWindow.pushEvent?.(`删除卷失败：${result.message}`, "err"); return; }
    if (activeWorkspace?.id === workspaceId) await refreshTree();
    const trashId = result.trashId;
    runtimeWindow.pushEvent?.(`已删除卷《${volume?.name ?? volumeId}》 <span class="ev-undo" data-action="undo" data-undo-id="${trashId}" data-undo-kind="volume" data-undo-workspace="${workspaceId}">↩ 撤回</span>`, "err");
    showUndoToast(`已删除卷《${volume?.name ?? volumeId}》`, () => void restoreVolume(workspaceId, trashId));
  }

  async function restoreVolume(workspaceId: string, trashId: string): Promise<void> {
    const result = await adapter.restoreVolume(workspaceId, trashId);
    if (!result.ok) { runtimeWindow.pushEvent?.(`恢复失败：${result.message}`, "err"); return; }
    if (activeWorkspace?.id === workspaceId) await refreshTree();
    runtimeWindow.pushEvent?.("↩ 已恢复卷", "ok");
  }

  // ===== 拖拽排序（Pointer Events）=====
  function bindTreeDrag(list: HTMLElement): void {
    let dragging: { workspaceId: string; chapterId: string; fromVol: string; moved: boolean; startX: number; startY: number } | null = null;
    let ghost: HTMLElement | null = null;
    let line: HTMLElement | null = null;
    const ensureGhost = () => { if (!ghost) { ghost = document.createElement("div"); ghost.className = "drag-ghost"; document.body.appendChild(ghost); } return ghost; };
    const ensureLine = () => { if (!line) { line = document.createElement("div"); line.className = "drag-line"; document.body.appendChild(line); } return line; };
    const hide = () => { ghost?.classList.remove("show"); line?.classList.remove("show"); };
    const clearMarks = () => list.querySelectorAll(".drop-target-vol").forEach((node) => node.classList.remove("drop-target-vol"));
    const resolveDrop = (x: number, y: number): { volId: string; afterId: string | null; atStart: boolean } | null => {
      if (!activeWorkspace) return null;
      const el = document.elementFromPoint(x, y);
      const item = el?.closest<HTMLElement>(".item[data-cid]");
      const volEl = el?.closest<HTMLElement>(".vol-head,.vol-body");
      if (item && item.dataset.cid !== dragging?.chapterId) {
        const rect = item.getBoundingClientRect();
        const before = (y - rect.top) < rect.height / 2;
        const volId = item.dataset.vol ?? "";
        const siblings = activeWorkspace.volumes.find((volume) => volume.id === volId)?.chapters ?? [];
        const idx = siblings.findIndex((chapter) => chapter.id === item.dataset.cid);
        if (before) {
          // 拖到该项上方：插到它之前；若是卷首项则 atStart
          return { volId, afterId: idx > 0 ? siblings[idx - 1]!.id : null, atStart: idx === 0 };
        }
        return { volId, afterId: item.dataset.cid!, atStart: false };
      }
      if (volEl && volEl.dataset.vol && volEl.dataset.vol !== dragging?.fromVol) {
        return { volId: volEl.dataset.vol, afterId: null, atStart: false };
      }
      return null;
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - dragging.startX, dy = e.clientY - dragging.startY;
      if (!dragging.moved && Math.hypot(dx, dy) < 6) return;
      if (!dragging.moved) { dragging.moved = true; ensureGhost(); ensureLine(); ghost!.textContent = `⠿ ${dragging.chapterId}`; ghost!.classList.add("show"); }
      e.preventDefault();
      ghost!.style.left = `${e.clientX + 14}px`;
      ghost!.style.top = `${e.clientY - 12}px`;
      clearMarks();
      const drop = resolveDrop(e.clientX, e.clientY);
      if (drop?.volId && drop.volId !== dragging.fromVol) {
        const target = [...list.querySelectorAll<HTMLElement>("[data-vol]")].find((node) => node.dataset.vol === drop.volId && node.classList.contains("vol-head")) ?? [...list.querySelectorAll<HTMLElement>("[data-vol]")].find((node) => node.dataset.vol === drop.volId);
        target?.classList.add("drop-target-vol");
      }
    };
    const onUp = async (e: PointerEvent) => {
      if (!dragging) return;
      const wasMoved = dragging.moved;
      const drop = wasMoved ? resolveDrop(e.clientX, e.clientY) : null;
      const workspaceId = dragging.workspaceId, chapterId = dragging.chapterId, fromVol = dragging.fromVol;
      dragging = null; hide(); clearMarks();
      if (!wasMoved || !drop || activeWorkspace?.id !== workspaceId) return;
      const targetVol = drop.volId || fromVol;
      // 同卷且落在末尾（afterId=null 且非 atStart）且已是末尾 → noop
      const siblings = activeWorkspace.volumes.find((volume) => volume.id === targetVol)?.chapters ?? [];
      const curIdx = siblings.findIndex((chapter) => chapter.id === chapterId);
      const atEnd = drop.afterId === null && !drop.atStart;
      if (targetVol === fromVol && ((drop.atStart && curIdx === 0) || (atEnd && curIdx === siblings.length - 1))) return;
      const result = await adapter.moveChapter(workspaceId, chapterId, targetVol, drop.afterId ?? undefined, drop.atStart);
      if (!result.ok) { runtimeWindow.pushEvent?.(`移动失败：${result.message}`, "err"); return; }
      if (activeWorkspace?.id !== workspaceId) return;
      await refreshTree();
      runtimeWindow.pushEvent?.(`已移动章节 · ${targetVol === fromVol ? "排序" : "移至 " + targetVol}`, "ok");
    };
    list.addEventListener("pointerdown", (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>(".item[data-cid]");
      if (!item) return;
      if ((e.target as HTMLElement).closest("[data-action]")) return;
      if (!activeWorkspace) return;
      dragging = { workspaceId: activeWorkspace.id, chapterId: item.dataset.cid!, fromVol: item.dataset.vol ?? "", moved: false, startX: e.clientX, startY: e.clientY };
    });
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", (e) => void onUp(e));
    document.addEventListener("pointercancel", () => { dragging = null; hide(); clearMarks(); });
  }

  async function refreshTree(): Promise<void> {
    if (!activeWorkspace) return;
    const token = workbenchContext.capture("workspace", "workspace-tree");
    const workspaceId = activeWorkspace.id;
    const list = await adapter.list();
    const workspace = list.find((candidate) => candidate.id === workspaceId) ?? null;
    if (!workspace || !workbenchContext.accepts(token)) return;
    activeWorkspace = workspace;
    const chapterList = document.getElementById("chapter-list");
    if (chapterList) chapterList.innerHTML = renderChapterList(workspace);

    const chapters = workspace.volumes.flatMap((volume) => volume.chapters);
    const activeChapterStillExists = activeChapterContent
      ? chapters.some((chapter) => chapter.id === activeChapterContent!.chapterId)
      : true;
    if (!activeChapterStillExists) {
      // 删除当前章节/卷后，拒绝旧异步结果并释放已保存的编辑器会话。
      editorSession?.autosave.dispose();
      editorSession?.editor.destroy();
      sourceEditorSession?.controller.dispose();
      editorSession = null;
      sourceEditorSession = null;
      chapterEditor = null;
      activeChapterContent = null;
      needsChapterReload = false;
      transitionContext(workspace.id, null, "bi");
      const next = chapters[0];
      if (next) {
        if (activeBtab() !== "bi") document.querySelector<HTMLElement>("[data-btab=\"bi\"]")?.click();
        await openChapterSafely(workspace.id, next.id);
      } else {
        const panel = document.getElementById("bpanel");
        if (panel) renderEmptyWorkspaceGuide(panel);
      }
    }
    updateRealStatusBar();
    void updateTermBadge(workspace.id);
    void updateMainActButton();
    // 重渲染后光标元素被销毁重建 → 校正位置（moveCursor 内部 fresh 才 snap，其余滑动）
    runtimeWindow.moveCursor?.();
    setTimeout(() => runtimeWindow.moveCursor?.(), 60);
    setTimeout(() => runtimeWindow.moveCursor?.(), 320);
  }

  function showUndoToast(message: string, onUndo: () => void): void {
    // 统一到设计稿的标题栏正中 toast（通用提示系统 window.showToast）
    const runtime = window as BridgeWindow & { showToast?: (message: string, opts?: { undo?: () => void; duration?: number }) => void };
    if (typeof runtime.showToast === "function") {
      runtime.showToast(message, { undo: onUndo, duration: 5000 });
      return;
    }
    let toast = document.getElementById("titlebar-toast");
    if (!toast) { toast = document.createElement("div"); toast.id = "titlebar-toast"; toast.className = "titlebar-toast"; document.body.appendChild(toast); }
    toast.innerHTML = `<span>${message}</span><span class="undo-btn">撤销</span>`;
    toast.classList.add("show");
    const btn = toast.querySelector(".undo-btn");
    btn?.addEventListener("click", () => { toast.classList.remove("show"); onUndo(); });
    window.clearTimeout((toast as HTMLElement & { _timer?: number })._timer);
    (toast as HTMLElement & { _timer?: number })._timer = window.setTimeout(() => toast.classList.remove("show"), 5000);
  }

  async function renderDashboard(): Promise<void> {
    const listResult = await adapter.list();
    const workspaces = listResult;
    // 设置面的填充与工作区卡无关，必须排在它的提前返回之前。
    // 排在后面时：只要工作区卡不在 DOM 里，「翻译偏好 / 模型·服务商」两格就静默留空——
    // 这个空曾被设计稿骨架文案盖着，骨架一撤就露了出来。
    (window as BridgeWindow & { fillEditorSettings?: () => void }).fillEditorSettings?.();
    void renderTranslationPrefs();
    void renderAiSettings();

    const card = document.querySelector<HTMLElement>("#wc-workspace-card .wc-body");
    if (!card) return;

    const currentRow = card.querySelector<HTMLElement>(".wc-row");
    const quickList = card.querySelector<HTMLElement>("[data-wc-quick-list]");
    const recentRow = [...card.querySelectorAll<HTMLElement>(".wc-row")].find((row) => row.querySelector(".wc-k")?.textContent?.trim() === "最近");
    if (currentRow) {
      const value = currentRow.querySelector<HTMLElement>(".wc-v");
      if (value) value.textContent = activeWorkspace ? `${activeWorkspace.name} · ${activeWorkspace.path}` : "尚未打开工作区";
    }
    if (recentRow) {
      const value = recentRow.querySelector<HTMLElement>(".wc-v");
      if (value) value.textContent = workspaces.length > 0 ? `${workspaces.length} 个工作区` : "—";
    }
    if (quickList) {
      if (workspaces.length === 0) {
        quickList.hidden = true;
        quickList.innerHTML = "";
      } else {
        quickList.hidden = false;
        const broken = workspaces.filter((workspace) => workspace.status === "missing" || workspace.status === "invalid");
        quickList.innerHTML = workspaces.slice(0, 5).map((workspace) => {
          const missing = workspace.status === "missing" || workspace.status === "invalid";
          return `
          <div class="wc-row" data-ws-quick="${escapeHtml(workspace.id)}" style="cursor:pointer;${missing ? "opacity:.55" : ""}" title="${escapeHtml(missing ? "目录已删除或移动" : workspace.path)}">
            <span class="wc-k">${escapeHtml(workspace.name)}${missing ? " <span style=\"color:var(--red);font-size:9px\">缺失</span>" : ""}</span>
            <span class="wc-v" style="color:var(--dimmer);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(workspace.path)}</span>
            ${missing ? `<span class="wc-forget" data-ws-forget="${escapeHtml(workspace.id)}" role="button" tabindex="0" title="从最近列表移除（不删任何文件）">移除</span>` : ""}
          </div>`;
        }).join("")
          // 失效条目一个个点太碎；有两条以上就给一次性出口
          + (broken.length > 1 ? `<div class="wc-row"><span class="wc-forget" id="ws-forget-all" role="button" tabindex="0" title="从最近列表移除全部失效条目（不删任何文件）">清理 ${broken.length} 个失效工作区</span></div>` : "");
        quickList.querySelectorAll<HTMLElement>("[data-ws-quick]").forEach((row) => {
          row.addEventListener("click", (event) => {
            if ((event.target as HTMLElement).dataset.wsForget !== undefined) return;
            void enterWorkbench(row.dataset.wsQuick ?? "");
          });
        });
        quickList.querySelectorAll<HTMLElement>("[data-ws-forget]").forEach((button) => {
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            void forgetWorkspaces([button.dataset.wsForget ?? ""]);
          });
        });
        document.getElementById("ws-forget-all")?.addEventListener("click", (event) => {
          event.stopPropagation();
          void forgetWorkspaces(broken.map((workspace) => workspace.id));
        });
      }
    }
    // 工作区卡「打开/新建」按钮接真实
    const actions = card.querySelector<HTMLElement>("[data-wc-actions]");
    if (actions) {
      const buttons = actions.querySelectorAll<HTMLElement>(".wc-btn");
      if (buttons[0]) buttons[0].onclick = () => void openWorkspacePicker();
      if (buttons[1]) buttons[1].onclick = () => void createWorkspaceFlow();
    }
    // 「上次编辑」卡：真实 session 数据
    await renderLastEditCard(workspaces);
  }

  // ===== 「模型 · 服务商」面板：唯一的编辑面（master-detail） =====
  //
  // 左列选服务商、右侧一处编辑到底：名称 / 接口地址 / API 类型 / 密钥 / 每个模型的规格与思考档位。
  // 此前这块是「只读展示 + 只能新增」——服务商能看、能选、能删、能加，唯独不能改，
  // 于是所有「改」的需求都溢出到手改 ~/.lightee/models.json（用户报告的
  // 「Responses/Completions 无法修改」「思考强度锁定」都是这一条的具体表现）。
  let aiActiveProvider = "";
  let aiCreatingProvider = false;
  /** 详细面板（服务商/模型管理）是否展开。默认关闭——设置面给的是快捷设置 */
  let aiAdvanced = false;

  interface AiModel { id: string; name: string; contextWindow?: number; maxTokens?: number; thinkingLevelMap?: Record<string, string | null> }
  interface AiProvider { id: string; name: string; baseUrl: string; api?: "openai-responses" | "openai-completions"; keyUrl?: string; hasKey?: boolean; models: AiModel[] }
  interface AiListValue { providers?: AiProvider[]; current?: string; currentThinking?: string; reviewThinking?: string }
  interface AiInvokeResult { ok?: boolean; value?: unknown; error?: { message?: string } }

  /** 通用 IPC 调用（AI 面板与翻译偏好共用），拿不到 bridge 时返回统一失败而不是抛 */
  function ipcInvoke(command: string, payload: unknown): Promise<AiInvokeResult> {
    const api = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<AiInvokeResult> } }).lightee;
    return api ? api.invoke(command, payload) : Promise.resolve({ ok: false, error: { message: "IPC 不可用" } });
  }

  function aiNote(message: string, ok: boolean): void {
    runtimeWindow.pushEvent?.(message, ok ? "ok" : "err");
  }

  /**
   * 思考档位下拉。未探测的档位**照样可选**，但标出来它没有依据——
   * 运行时（pi-ai）本就会把未写条目的档位原样透传，此前渲染层比它严得多，
   * 把整个下拉锁成「能力未探测」，而又没有任何界面能写这份 map。
   */
  function renderThinkingOptions(select: HTMLSelectElement | null, map: Record<string, string | null> | undefined, current: string): void {
    if (!select) return;
    const levels = supportedThinkingLevels(map);
    select.disabled = levels.length === 0;
    select.title = levels.length === 0
      ? "该模型已探测为不支持思考参数"
      : "未标注「未探测」的档位来自实测；未探测的档位运行时会原样透传给服务商";
    select.innerHTML = levels.length
      ? levels.map((level) => `<option value="${level.id}">${escapeHtml(level.label)}${level.proven ? "" : "（未探测）"}</option>`).join("")
      : `<option value="">不支持思考</option>`;
    select.value = levels.some((level) => level.id === current) ? current : (levels[0]?.id ?? "");
  }

  // ===== 翻译偏好：引号策略 / 翻译指南 / 全书上下文预算（真实 config.json） =====
  //
  // 审计发现这一格此前四行里三行是假的：引号策略与并发数只改文本、从不落盘；翻译指南更糟——
  // 推一条「✓ 翻译指南已保存（translation.guide）」然后把内容丢进内存变量，而 translation.guide
  // 是注入每次翻译系统提示的核心杠杆。**宣称保存却丢弃，比没有这个控件更坏**：用户以为配置过了。
  let prefsRevision = 0;

  async function readPrefs(workspaceId: string): Promise<Record<string, unknown> | undefined> {
    const result = await ipcInvoke("settings.read", { workspaceId });
    const value = (result?.ok ? result.value : undefined) as { values?: Record<string, unknown>; revision?: number } | undefined;
    if (!value) return undefined;
    prefsRevision = value.revision ?? 0;
    return value.values ?? {};
  }

  async function writePref(workspaceId: string, key: string, value: unknown, label: string): Promise<boolean> {
    const result = await ipcInvoke("settings.write", { workspaceId, baseRevision: prefsRevision, key, value });
    const written = (result?.ok ? result.value : undefined) as { revision?: number } | undefined;
    if (result?.ok && written) {
      prefsRevision = written.revision ?? prefsRevision;
      aiNote(`${label} 已保存`, true);
      return true;
    }
    aiNote(`${label} 保存失败：${result?.error?.message ?? ""}`, false);
    return false;
  }

  function translationSettings(values: Record<string, unknown> | undefined): {
    guide?: string;
    styleAnchor?: string;
  } {
    return (values?.translation ?? {}) as {
      guide?: string;
      styleAnchor?: string;
    };
  }

  async function renderTranslationPrefs(): Promise<void> {
    const rows = document.getElementById("tp-rows");
    if (!rows) return;
    const target = await resolveSettingsWorkspace();
    if (!target) { rows.innerHTML = `<div class="ai-hint">打开一个工作区后可配置翻译偏好。</div>`; return; }
    const values = await readPrefs(target.id);
    if (!values) return;
    const quote = values.quoteStyle === "jp" ? "jp" : "zh";
    const translation = translationSettings(values);
    // EX-05：术语注入只有一种形态——累积词表、发现顺序追加、永不重排。
    // 原来的 subset/frozen 两种模式随译前提取链退役（表在翻译期间会长，冻结的前提不成立）。
    const styleAnchor = typeof translation.styleAnchor === "string" ? translation.styleAnchor : "";

    rows.innerHTML = `
      <div class="wc-kv">
        <span class="k">对话引号</span><span class="v"><select class="tp-input" data-tp-quote>
        <option value="zh"${quote === "zh" ? " selected" : ""}>中式 “”</option>
        <option value="jp"${quote === "jp" ? " selected" : ""}>日式 「」</option>
      </select></span></div>
      <div class="wc-kv"><span class="k">翻译指南</span><span class="v" style="cursor:pointer;color:var(--accent)" data-tp-guide>✎ 编辑</span></div>
      <div class="wc-kv"><span class="k">风格参照</span><span class="v"><textarea class="tp-input" rows="3" placeholder="贴一两段你满意的中文译文（可留空）" data-tp-anchor>${escapeHtml(styleAnchor)}</textarea></span>
      </div>`;

    const quoteSel = rows.querySelector<HTMLSelectElement>("[data-tp-quote]");
    if (quoteSel) quoteSel.onchange = () => { void writePref(target.id, "quoteStyle", quoteSel.value, "对话引号"); };


    const anchorInput = rows.querySelector<HTMLTextAreaElement>("[data-tp-anchor]");
    // change 而不是 input：每敲一个字就写一次 config.json 会把 revision 冲到天上，
    // 并且和别处的写入互相撞版本。
    if (anchorInput) anchorInput.onchange = () => { void writePref(target.id, "translation.styleAnchor", anchorInput.value, "风格参照"); };

    const shell = window as BridgeWindow & { editGuide?: () => void };
    const guideRow = rows.querySelector<HTMLElement>("[data-tp-guide]");
    if (guideRow) guideRow.onclick = () => shell.editGuide?.();
  }

  /** 翻译指南的真实读写（prototype 的 editGuide/saveGuide/resetGuide 在真实模式下委托到这里） */
  function installTranslationGuideBridge(): void {
    (window as BridgeWindow & { __lighteeTranslationGuide?: unknown }).__lighteeTranslationGuide = {
      load: async (): Promise<string> => {
        const target = await resolveSettingsWorkspace();
        if (!target) return "";
        return translationSettings(await readPrefs(target.id)).guide ?? "";
      },
      save: async (text: string): Promise<void> => {
        const target = await resolveSettingsWorkspace();
        if (!target) { aiNote("没有打开的工作区，翻译指南未保存", false); return; }
        await readPrefs(target.id); // 取最新 revision，避免与别处的写入撞版本
        await writePref(target.id, "translation.guide", text, "翻译指南");
      },
      // 恢复默认 = 写空串：config-service 见到空白即视为未设置，引擎回落到 DEFAULT_GUIDE
      reset: async (): Promise<void> => {
        const target = await resolveSettingsWorkspace();
        if (!target) return;
        await readPrefs(target.id);
        await writePref(target.id, "translation.guide", "", "翻译指南（恢复默认）");
      },
    };
  }

  async function renderAiSettings(): Promise<void> {
    const quickEl = document.getElementById("ai-quick");
    const advancedEl = document.getElementById("ai-advanced");
    const listEl = document.getElementById("ai-provider-list");
    const detailEl = document.getElementById("ai-provider-detail");
    if (!quickEl || !advancedEl || !listEl || !detailEl) return;
    const target = await resolveSettingsWorkspace();
    if (!target) {
      // 说清楚为什么这里是空的。从前这里直接 return，留下一个不说话的空框——
      // 而在 lighteeReal() 判据修好之前，那个空框恰好被设计稿骨架文案填着，
      // 于是「没有工作区就配不了模型」这件事一直没人看见。
      quickEl.innerHTML = `<div class="ai-hint">打开或新建一个工作区后，可以在这里配置服务商与模型。</div>`;
      advancedEl.hidden = true;
      return;
    }
    const result = await ipcInvoke("ai.providers.list", { workspaceId: target.id });
    const value = (result?.ok ? result.value : undefined) as AiListValue | undefined;
    const providers = value?.providers ?? [];
    const current = value?.current ?? "";
    // 默认给快捷设置。完整的服务商/模型管理是低频操作，把它当默认设置面对普通使用是负担。
    quickEl.hidden = aiAdvanced;
    advancedEl.hidden = !aiAdvanced;
    if (!aiAdvanced) { renderAiQuick(quickEl, providers, current, value, target.id); return; }
    if (!aiCreatingProvider) aiActiveProvider = resolveSelectedProvider(providers.map((provider) => provider.id), aiActiveProvider, current);
    renderProviderList(listEl, providers, current);
    const selected = providers.find((provider) => provider.id === aiActiveProvider);
    if (aiCreatingProvider) renderProviderCreate(detailEl);
    else if (selected) renderProviderDetail(detailEl, selected, target.id, current, value);
    else detailEl.innerHTML = `<div class="ai-md-empty">尚未配置服务商。点击左侧「＋ 添加服务商」，可选用预置模板。</div>`;
  }

  /**
   * 快捷设置：日常只需要「用哪个服务商的哪个模型、密钥有没有、思考多深、连不连得上」。
   * 服务商与模型的管理（API 类型、上下文窗口、思考档位映射、逐档探测）是低频操作，
   * 放进详细面板按需展开——把管理面当默认设置面，对普通使用是负担。
   */
  function renderAiQuick(quickEl: HTMLElement, providers: AiProvider[], current: string, listValue: AiListValue | undefined, workspaceId: string): void {
    const openAdvanced = `<button class="ai-mini-btn" data-to-advanced>管理服务商与模型 →</button>`;
    if (providers.length === 0) {
      quickEl.innerHTML = `<div class="ai-md-empty">还没有配置任何服务商。<br>${openAdvanced}</div>`;
      bindAdvancedToggle(quickEl);
      return;
    }
    const providerId = resolveSelectedProvider(providers.map((provider) => provider.id), aiActiveProvider, current);
    const provider = providers.find((candidate) => candidate.id === providerId);
    if (!provider) return;
    const currentModelId = current.startsWith(`${provider.id}/`) ? current.slice(provider.id.length + 1) : "";
    const model = provider.models.find((candidate) => candidate.id === currentModelId);
    const keyHint = provider.hasKey ? "已保存（重填可覆盖）" : (isLocalBaseUrl(provider.baseUrl) ? "本地服务，通常无需密钥" : "sk-…（保存后即可使用）");

    const keyBadge = provider.hasKey ? `<span class="ai-key-status ok">✓ 已配</span>`
      : isLocalBaseUrl(provider.baseUrl) ? `<span class="ai-key-status">本地服务</span>`
      : `<span class="ai-key-status">未配置</span>`;
    quickEl.innerHTML = `
      <div class="ai-grid">
        <div class="ai-field"><span class="ai-label">服务商</span><select class="ai-input" data-q-provider>${
          providers.map((candidate) => {
            const mark = candidate.hasKey ? " · ✓已配" : (isLocalBaseUrl(candidate.baseUrl) ? " · 本地" : " · 未配密钥");
            return `<option value="${escapeHtml(candidate.id)}"${candidate.id === provider.id ? " selected" : ""}>${escapeHtml(candidate.name)}${mark}</option>`;
          }).join("")
        }</select></div>
        <div class="ai-field"><span class="ai-label">模型</span><select class="ai-input" data-q-model>${
          provider.models.length
            ? provider.models.map((candidate) => `<option value="${escapeHtml(candidate.id)}"${candidate.id === currentModelId ? " selected" : ""}>${escapeHtml(candidate.name)}</option>`).join("")
            : `<option value="">（该服务商还没有模型）</option>`
        }</select></div>
      </div>
      <div class="ai-field">
        <div class="ai-label-line">
          <span class="ai-label">API 密钥</span>${keyBadge}
          ${provider.keyUrl ? `<span class="ai-mini" data-q-key-open title="在浏览器打开该服务商的密钥页面">获取 Key ↗</span>` : ""}
        </div>
        <div class="ai-control">
          <input class="ai-input" type="password" data-q-key placeholder="${escapeHtml(keyHint)}" />
          <span class="wc-btn primary" data-q-key-save style="flex:0 0 auto">保存</span>
        </div>
      </div>
      <div class="ai-field">
        <div class="ai-label-line"><span class="ai-label">思考强度 · 连接测试</span></div>
        <div class="ai-control">
          <select class="ai-input" data-q-think style="flex:0 0 auto;max-width:170px"></select>
          <span class="wc-btn primary" data-q-test style="flex:0 0 auto">测试连接</span>
          <span class="ai-result" data-q-result></span>
        </div>
      </div>
      <div class="ai-quick-foot">${openAdvanced}</div>`;

    bindAdvancedToggle(quickEl);
    const resultEl = quickEl.querySelector<HTMLElement>("[data-q-result]");
    const say = (text: string, ok: boolean): void => {
      if (!resultEl) return;
      resultEl.textContent = text;
      resultEl.style.color = ok ? "var(--green)" : "var(--red)";
    };

    const providerSel = quickEl.querySelector<HTMLSelectElement>("[data-q-provider]");
    // 换服务商只切视图，不动配置：真正决定「用哪个模型」的是下面的模型选择。
    if (providerSel) providerSel.onchange = () => { aiActiveProvider = providerSel.value; void renderAiSettings(); };

    const modelSel = quickEl.querySelector<HTMLSelectElement>("[data-q-model]");
    if (modelSel) modelSel.onchange = () => {
      if (!modelSel.value) return;
      void writeActiveModel(workspaceId, `${provider.id}/${modelSel.value}`).then((written) => {
        aiNote(written.ok ? `当前模型：${provider.id}/${modelSel.value}` : "模型保存失败", written.ok);
        void renderAiSettings();
      });
    };

    const keyInput = quickEl.querySelector<HTMLInputElement>("[data-q-key]");
    const keySave = quickEl.querySelector<HTMLElement>("[data-q-key-save]");
    if (keySave) keySave.onclick = () => {
      const apiKey = keyInput?.value.trim() ?? "";
      if (!apiKey) { runtimeWindow.showToast?.("请输入 API 密钥", { duration: 2400 }); return; }
      void ipcInvoke("ai.key.write", { providerId: provider.id, apiKey }).then((written) => {
        if (keyInput) keyInput.value = "";
        aiNote(written?.ok ? `密钥已保存：${provider.id}` : `密钥保存失败：${written?.error?.message ?? ""}`, Boolean(written?.ok));
        void renderAiSettings();
      });
    };
    const keyOpen = quickEl.querySelector<HTMLElement>("[data-q-key-open]");
    if (keyOpen) keyOpen.onclick = () => {
      void ipcInvoke("ai.key.open", { providerId: provider.id }).then((opened) => aiNote(opened?.ok ? "已在浏览器打开密钥页面" : "打开失败", Boolean(opened?.ok)));
    };

    const thinkSel = quickEl.querySelector<HTMLSelectElement>("[data-q-think]");
    renderThinkingOptions(thinkSel, model?.thinkingLevelMap, listValue?.currentThinking ?? "high");
    if (thinkSel) thinkSel.onchange = () => {
      void ipcInvoke("ai.thinking.write", { workspaceId, thinking: thinkSel.value }).then((written) => {
        aiNote(written?.ok ? `翻译思考：${thinkSel.value}` : "保存失败", Boolean(written?.ok));
      });
    };

    const testBtn = quickEl.querySelector<HTMLElement>("[data-q-test]");
    if (testBtn) testBtn.onclick = () => {
      const modelRef = modelSel?.value ? `${provider.id}/${modelSel.value}` : undefined;
      say("测试中…", true);
      void ipcInvoke("ai.test", { workspaceId, model: modelRef }).then((tested) => {
        const outcome = (tested?.ok ? tested.value : undefined) as { ok?: boolean; message?: string; model?: string } | undefined;
        if (!tested?.ok || !outcome) { say("测试失败", false); return; }
        // 一次真实调用的结论——标题栏的「连接正常/失败」只认这个，不认「有密钥」
        if (outcome.model) recordProbe({ ok: outcome.ok === true, model: outcome.model });
        say(outcome.ok ? `✓ ${outcome.message ?? "连接成功"}` : `✗ ${outcome.message ?? "连接失败"}`, outcome.ok === true);
      });
    };
  }

  function bindAdvancedToggle(root: HTMLElement): void {
    root.querySelectorAll<HTMLElement>("[data-to-advanced]").forEach((button) => {
      button.onclick = () => { aiAdvanced = true; void renderAiSettings(); };
    });
    root.querySelectorAll<HTMLElement>("[data-to-quick]").forEach((button) => {
      button.onclick = () => { aiAdvanced = false; aiCreatingProvider = false; void renderAiSettings(); };
    });
  }

  function renderProviderList(listEl: HTMLElement, providers: AiProvider[], current: string): void {
    const owner = current.split("/")[0] ?? "";
    listEl.innerHTML = providers.map((provider) => {
      const on = !aiCreatingProvider && provider.id === aiActiveProvider;
      // 本机服务不需要密钥，别给它挂「未配」这种假警报
      const badge = provider.hasKey ? `<span class="kd ok">✓</span>`
        : isLocalBaseUrl(provider.baseUrl) ? `<span class="kd">本地</span>`
        : `<span class="kd">未配</span>`;
      const inUse = provider.id === owner ? `<span class="cur" title="当前翻译使用的服务商">●</span>` : "";
      return `<div class="ai-md-item ${on ? "on" : ""}" data-provider="${escapeHtml(provider.id)}" title="${escapeHtml(provider.baseUrl)}">${inUse}<span class="nm">${escapeHtml(provider.name)}</span>${badge}</div>`;
    }).join("") + `<div class="ai-md-item add ${aiCreatingProvider ? "on" : ""}" data-new-provider>＋ 添加服务商</div>`;

    listEl.querySelectorAll<HTMLElement>("[data-provider]").forEach((item) => {
      item.onclick = () => { aiCreatingProvider = false; aiActiveProvider = item.dataset.provider ?? ""; void renderAiSettings(); };
    });
    const addItem = listEl.querySelector<HTMLElement>("[data-new-provider]");
    if (addItem) addItem.onclick = () => { aiCreatingProvider = true; void renderAiSettings(); };
  }

  /** 新建服务商。保存走的是与编辑同一条 `ai.provider.upsert`——两者本来就该是同一个编辑器 */
  function renderProviderCreate(detailEl: HTMLElement): void {
    detailEl.innerHTML = `
      <div class="ai-sect">
        <div class="ai-sect-head">添加服务商<span class="acts"><span class="ai-mini" data-to-quick>← 返回快捷设置</span></span></div>
        <div class="ai-field">
          <div class="ai-label-line"><span class="ai-label">模板</span><span class="ai-hint">选择预置模板可自动填入下列字段。</span></div>
          <select class="ai-input" data-preset><option value="">自定义（从零填写）</option></select>
        </div>
        <div class="ai-grid">
          <div class="ai-field"><span class="ai-label">服务商 id</span><input class="ai-input" data-c-id placeholder="my-provider" /></div>
          <div class="ai-field"><span class="ai-label">显示名称</span><input class="ai-input" data-c-name placeholder="My Provider" /></div>
        </div>
        <div class="ai-field"><span class="ai-label">接口地址</span><input class="ai-input" data-c-base placeholder="https://api.example.com/v1" /></div>
        <div class="ai-grid">
          <div class="ai-field">
            <span class="ai-label">API 类型</span>
            <select class="ai-input" data-c-api>
              <option value="openai-responses">OpenAI Responses</option>
              <option value="openai-completions">OpenAI Completions</option>
            </select>
          </div>
          <div class="ai-field"><span class="ai-label">模型 id（逗号分隔，可留空）</span><input class="ai-input" data-c-models placeholder="保存后也可用「⟳ 获取模型」拉取" /></div>
        </div>
      </div>
      <div class="ai-btns">
        <span class="wc-btn primary" data-c-save>保存服务商</span>
        <button class="ai-mini-btn" data-c-cancel>取消</button>
      </div>
      <div class="ai-hint">接口协议。OpenAI 官方使用 Responses，多数兼容服务商使用 Completions。保存后可随时修改。</div>`;

    bindAdvancedToggle(detailEl);
    const presetSel = detailEl.querySelector<HTMLSelectElement>("[data-preset]");
    void ipcInvoke("ai.provider.presets", {}).then((result) => {
      const presets = (result?.ok ? result.value : []) as Array<{ id: string; name: string; baseUrl: string; api: string; models: Array<{ id: string }> }>;
      if (!presetSel) return;
      presetSel.innerHTML = `<option value="">自定义（从零填写）</option>` + presets.map((preset) => `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.name)}</option>`).join("");
      presetSel.onchange = () => {
        const preset = presets.find((candidate) => candidate.id === presetSel.value);
        if (!preset) return;
        const set = (selector: string, text: string): void => {
          const el = detailEl.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
          if (el) el.value = text;
        };
        set("[data-c-id]", preset.id);
        set("[data-c-name]", preset.name);
        set("[data-c-base]", preset.baseUrl);
        set("[data-c-api]", preset.api);
        set("[data-c-models]", preset.models.map((model) => model.id).join(", "));
      };
    });

    const readField = (selector: string): string => detailEl.querySelector<HTMLInputElement | HTMLSelectElement>(selector)?.value.trim() ?? "";
    const cancel = detailEl.querySelector<HTMLElement>("[data-c-cancel]");
    if (cancel) cancel.onclick = () => { aiCreatingProvider = false; void renderAiSettings(); };
    const save = detailEl.querySelector<HTMLElement>("[data-c-save]");
    if (save) save.onclick = () => {
      const providerId = readField("[data-c-id]");
      const baseUrl = readField("[data-c-base]");
      if (!providerId || !baseUrl) { runtimeWindow.showToast?.("请填写服务商 id 和接口地址", { duration: 2600 }); return; }
      const api = readField("[data-c-api]") as "openai-responses" | "openai-completions";
      const models = readField("[data-c-models]").split(",").map((item) => item.trim()).filter(Boolean);
      void ipcInvoke("ai.provider.upsert", { providerId, name: readField("[data-c-name]") || providerId, baseUrl, api }).then(async (result) => {
        if (!result?.ok) { aiNote(`服务商保存失败：${result?.error?.message ?? ""}`, false); return; }
        for (const modelId of models) await ipcInvoke("ai.model.upsert", { providerId, modelId, modelName: modelId });
        aiNote(`服务商已保存：${providerId}`, true);
        aiCreatingProvider = false;
        aiActiveProvider = providerId;
        await renderAiSettings();
      });
    };
  }

  function modelRowHtml(model: AiModel, isCurrent: boolean): string {
    const preset = identifyThinkingPreset(model.thinkingLevelMap);
    const options = (["unprobed", "none", "standard", "full", "probed", "custom"] as const)
      // 「已探测」「自定义」是结果而不是可选形态，只有当前就是它时才列出来，
      // 否则会诱导用户去选一个空动作
      .filter((id) => !THINKING_PRESET_RESULT_ONLY.has(id) || preset === id)
      .map((id) => `<option value="${id}"${id === preset ? " selected" : ""}>${escapeHtml(THINKING_PRESET_LABELS[id])}</option>`)
      .join("");
    return `<div class="ai-model-row" data-model="${escapeHtml(model.id)}">
      <div class="mr-main">
        <button class="ai-model-use ${isCurrent ? "on" : ""}" data-use title="设为当前翻译模型">${isCurrent ? "●" : "○"}</button>
        <input data-m-name value="${escapeHtml(model.name)}" title="${escapeHtml(model.id)}" />
        <span class="ai-model-acts">
          <button class="ai-mini-btn" data-m-probe title="逐档发送最小请求，按服务商实际接受情况写入思考档位映射。">探测</button>
          <button class="ai-mini-btn danger" data-m-del title="从配置中删除该模型">×</button>
        </span>
      </div>
      <div class="mr-specs">
        <label title="模型上下文窗口（token）。留空时依次回落至工作区设置「上下文窗口」与 131072。">上下文<input data-m-ctx type="number" min="1" placeholder="默认" value="${model.contextWindow ?? ""}" /></label>
        <label title="单次响应的最大输出（token）。留空时使用 8192。">最大输出<input data-m-max type="number" min="1" placeholder="默认" value="${model.maxTokens ?? ""}" /></label>
        <label title="思考档位映射。可选用预设，或通过「探测」按实测结果写入。">思考档位<select data-m-think>${options}</select></label>
      </div>
    </div>`;
  }

  function renderProviderDetail(detailEl: HTMLElement, provider: AiProvider, workspaceId: string, current: string, listValue: AiListValue | undefined): void {
    const currentModelId = current.startsWith(`${provider.id}/`) ? current.slice(provider.id.length + 1) : "";
    const currentModel = provider.models.find((model) => model.id === currentModelId);
    const keyPlaceholder = provider.hasKey ? "已保存（重填可覆盖）" : (isLocalBaseUrl(provider.baseUrl) ? "本地服务，通常无需密钥" : "sk-…");
    const keyBadge = provider.hasKey ? `<span class="ai-key-status ok">✓ 已配</span>`
      : isLocalBaseUrl(provider.baseUrl) ? `<span class="ai-key-status">本地服务</span>`
      : `<span class="ai-key-status">未配置</span>`;
    const modelsTable = provider.models.length
      ? `<div class="ai-models">${provider.models.map((model) => modelRowHtml(model, model.id === currentModelId)).join("")}</div>`
      : `<div class="ai-models"><div class="ai-model-empty">本服务商尚未配置模型。可通过「⟳ 获取模型」从接口获取，或「＋ 添加模型」手动录入。</div></div>`;

    detailEl.innerHTML = `
      <div class="ai-sect">
        <div class="ai-sect-head">服务商<span class="acts"><span class="ai-mini" data-to-quick>← 返回快捷设置</span></span></div>
        <div class="ai-grid">
          <div class="ai-field"><span class="ai-label">显示名称</span><input class="ai-input" data-p-name value="${escapeHtml(provider.name)}" /></div>
          <div class="ai-field"><span class="ai-label">接口地址</span><input class="ai-input" data-p-base value="${escapeHtml(provider.baseUrl)}" /></div>
        </div>
        <div class="ai-field">
          <div class="ai-label-line"><span class="ai-label">API 类型</span><span class="ai-hint">接口协议。OpenAI 官方使用 Responses，多数兼容服务商使用 Completions。</span></div>
          <div class="ai-control">
            <select class="ai-input" data-p-api style="flex:0 0 auto;max-width:210px">
              <option value="openai-responses"${provider.api === "openai-responses" ? " selected" : ""}>OpenAI Responses</option>
              <option value="openai-completions"${provider.api !== "openai-responses" ? " selected" : ""}>OpenAI Completions</option>
            </select>
            <span class="wc-btn primary" data-p-save style="flex:0 0 auto">保存服务商</span>
          </div>
        </div>
      </div>

      <div class="ai-sect">
        <div class="ai-sect-head">密钥</div>
        <div class="ai-field">
          <div class="ai-label-line">
            <span class="ai-label">API 密钥</span>${keyBadge}
            ${provider.keyUrl ? `<span class="ai-mini" data-k-open>获取 Key ↗</span>` : ""}
            <span class="ai-mini" data-k-oauth>OAuth 登录</span>
            <span class="ai-mini" data-k-del>清除 Key</span>
          </div>
          <div class="ai-control">
            <input class="ai-input" type="password" data-k-input placeholder="${escapeHtml(keyPlaceholder)}" />
            <span class="wc-btn primary" data-k-save style="flex:0 0 auto">保存</span>
          </div>
        </div>
      </div>

      <div class="ai-sect">
        <div class="ai-sect-head">模型<span class="acts">
          <button class="ai-mini-btn" data-m-refresh title="从服务商接口拉取真实模型列表">⟳ 获取模型</button>
          <button class="ai-mini-btn" data-m-add>＋ 添加模型</button>
        </span></div>
        <div data-models>${modelsTable}</div>
        ${currentModel ? `<div class="ai-current-strip">
          当前模型 <b>${escapeHtml(currentModel.name)}</b>
          <span>思考</span><select data-t-write="ai.thinking.write"></select>
        </div>` : `<div class="ai-probe-note">当前工作区尚未选定本服务商下的模型。点击模型左侧圆点即可设为当前模型。</div>`}
      </div>

      <div class="ai-btns">
        <button class="ai-mini-btn" data-test>测试连接</button>
        <button class="ai-mini-btn" data-open-config>打开配置文件</button>
        <button class="ai-mini-btn danger" data-p-del>删除服务商</button>
        <span class="ai-result" data-result></span>
      </div>`;

    bindAdvancedToggle(detailEl);
    const resultEl = detailEl.querySelector<HTMLElement>("[data-result]");
    const say = (text: string, ok: boolean): void => {
      if (!resultEl) return;
      resultEl.textContent = text;
      resultEl.style.color = ok ? "var(--green)" : "var(--red)";
    };
    const refresh = (): void => { void renderAiSettings(); };

    // —— 服务商元数据（含 API 类型）——
    const saveProvider = detailEl.querySelector<HTMLElement>("[data-p-save]");
    if (saveProvider) saveProvider.onclick = () => {
      const name = detailEl.querySelector<HTMLInputElement>("[data-p-name]")?.value.trim() || provider.id;
      const baseUrl = detailEl.querySelector<HTMLInputElement>("[data-p-base]")?.value.trim() ?? "";
      const api = (detailEl.querySelector<HTMLSelectElement>("[data-p-api]")?.value ?? "openai-completions") as "openai-responses" | "openai-completions";
      if (!baseUrl) { runtimeWindow.showToast?.("接口地址不能为空", { duration: 2400 }); return; }
      void ipcInvoke("ai.provider.upsert", { providerId: provider.id, name, baseUrl, api }).then((result) => {
        aiNote(result?.ok ? `已保存服务商：${provider.id}` : `保存失败：${result?.error?.message ?? ""}`, Boolean(result?.ok));
        refresh();
      });
    };

    // —— 密钥 ——
    const keySave = detailEl.querySelector<HTMLElement>("[data-k-save]");
    if (keySave) keySave.onclick = () => {
      const input = detailEl.querySelector<HTMLInputElement>("[data-k-input]");
      const apiKey = input?.value.trim() ?? "";
      if (!apiKey) { runtimeWindow.showToast?.("请输入 API 密钥", { duration: 2400 }); return; }
      void ipcInvoke("ai.key.write", { providerId: provider.id, apiKey }).then((result) => {
        if (input) input.value = "";
        aiNote(result?.ok ? `密钥已保存：${provider.id}` : `密钥保存失败：${result?.error?.message ?? ""}`, Boolean(result?.ok));
        refresh();
      });
    };
    const keyDelete = detailEl.querySelector<HTMLElement>("[data-k-del]");
    if (keyDelete) keyDelete.onclick = () => {
      void ipcInvoke("ai.key.delete", { providerId: provider.id }).then((result) => {
        aiNote(result?.ok ? `已清除 ${provider.id} 的密钥` : "清除失败", Boolean(result?.ok));
        refresh();
      });
    };
    const keyOpen = detailEl.querySelector<HTMLElement>("[data-k-open]");
    if (keyOpen) keyOpen.onclick = () => {
      void ipcInvoke("ai.key.open", { providerId: provider.id }).then((result) => aiNote(result?.ok ? "已在浏览器打开密钥页面" : "打开失败", Boolean(result?.ok)));
    };
    const oauth = detailEl.querySelector<HTMLElement>("[data-k-oauth]");
    if (oauth) oauth.onclick = () => {
      oauth.textContent = "等待授权…";
      void ipcInvoke("ai.oauth.login", { providerId: provider.id }).then((result) => {
        if (!result?.ok) {
          oauth.textContent = "OAuth";
          runtimeWindow.showToast?.(result?.error?.message ?? "该服务商未配置 oauth，请用 API 密钥", { duration: 3200 });
          return;
        }
        void ipcInvoke("ai.oauth.wait", { providerId: provider.id }).then((waited) => {
          oauth.textContent = "OAuth";
          aiNote(waited?.ok ? `OAuth 登录成功：${provider.id}` : `OAuth 登录失败：${waited?.error?.message ?? ""}`, Boolean(waited?.ok));
          refresh();
        });
      });
    };

    // —— 模型行：改名 / 规格 / 思考档位 / 探测 / 删除 / 设为当前 ——
    detailEl.querySelectorAll<HTMLElement>("[data-model]").forEach((row) => {
      const modelId = row.dataset.model ?? "";
      const upsert = (payload: Record<string, unknown>, note: string): void => {
        void ipcInvoke("ai.model.upsert", { providerId: provider.id, modelId, ...payload }).then((result) => {
          aiNote(result?.ok ? note : `保存失败：${result?.error?.message ?? ""}`, Boolean(result?.ok));
          refresh();
        });
      };
      const nameInput = row.querySelector<HTMLInputElement>("[data-m-name]");
      if (nameInput) nameInput.onchange = () => upsert({ modelName: nameInput.value.trim() || modelId }, `已改名：${modelId}`);
      // 数字框留空时不下发：契约里 undefined 表示「不改这项」，没有「清空」这个语义
      const ctxInput = row.querySelector<HTMLInputElement>("[data-m-ctx]");
      if (ctxInput) ctxInput.onchange = () => {
        const parsed = Number.parseInt(ctxInput.value, 10);
        if (Number.isSafeInteger(parsed) && parsed > 0) upsert({ contextWindow: parsed }, `上下文窗口：${parsed}`);
      };
      const maxInput = row.querySelector<HTMLInputElement>("[data-m-max]");
      if (maxInput) maxInput.onchange = () => {
        const parsed = Number.parseInt(maxInput.value, 10);
        if (Number.isSafeInteger(parsed) && parsed > 0) upsert({ maxTokens: parsed }, `最大输出：${parsed}`);
      };
      const thinkSel = row.querySelector<HTMLSelectElement>("[data-m-think]");
      if (thinkSel) thinkSel.onchange = () => {
        const preset = thinkSel.value;
        if (preset === "custom") return;
        // 「未探测」= 清空映射，回到运行时的默认透传行为
        const map = preset === "unprobed" ? {} : THINKING_PRESET_MAPS[preset as "none" | "standard" | "full"];
        upsert({ thinkingLevelMap: map }, `思考档位：${THINKING_PRESET_LABELS[preset as "unprobed" | "none" | "standard" | "full"]}`);
      };
      const probeBtn = row.querySelector<HTMLElement>("[data-m-probe]");
      if (probeBtn) probeBtn.onclick = () => {
        probeBtn.textContent = "探测中…";
        (probeBtn as HTMLButtonElement).disabled = true;
        say(`正在逐档试探 ${modelId}（每档一次极小请求）…`, true);
        void ipcInvoke("ai.thinking.probe", { providerId: provider.id, modelId }).then((result) => {
          if (!result?.ok) {
            say(`探测失败：${result?.error?.message ?? ""}`, false);
            probeBtn.textContent = "探测";
            (probeBtn as HTMLButtonElement).disabled = false;
            return;
          }
          const value = result.value as { outcomes: Array<{ candidate: string; accepted: boolean; reasoned: boolean }> };
          const okList = value.outcomes.filter((outcome) => outcome.accepted);
          const reasoning = okList.filter((outcome) => outcome.reasoned).length;
          aiNote(`${modelId} 探测完成：${okList.length}/${value.outcomes.length} 档被接受${reasoning ? `，其中 ${reasoning} 档回传了思考内容` : "（服务商未回传思考内容）"}`, true);
          refresh();
        });
      };
      const delBtn = row.querySelector<HTMLElement>("[data-m-del]");
      if (delBtn) delBtn.onclick = () => {
        void ipcInvoke("ai.model.delete", { providerId: provider.id, modelId }).then((result) => {
          aiNote(result?.ok ? `已删除模型：${modelId}` : "删除失败", Boolean(result?.ok));
          refresh();
        });
      };
      const useBtn = row.querySelector<HTMLElement>("[data-use]");
      if (useBtn) useBtn.onclick = () => {
        void writeActiveModel(workspaceId, `${provider.id}/${modelId}`).then((result) => {
          aiNote(result.ok ? `当前模型：${provider.id}/${modelId}` : "模型保存失败", result.ok);
          refresh();
        });
      };
    });

    // —— 底部动作 ——
    const refreshModels = detailEl.querySelector<HTMLElement>("[data-m-refresh]");
    if (refreshModels) refreshModels.onclick = () => {
      const baseUrl = detailEl.querySelector<HTMLInputElement>("[data-p-base]")?.value.trim() ?? provider.baseUrl;
      const typed = detailEl.querySelector<HTMLInputElement>("[data-k-input]")?.value.trim();
      say("获取中…", true);
      void ipcInvoke("ai.models.detect", { workspaceId, providerId: provider.id, baseUrl, apiKey: typed || undefined }).then(async (result) => {
        const value = (result?.ok ? result.value : undefined) as { models?: Array<{ id: string; name: string; contextWindow?: number }> } | undefined;
        if (!result?.ok || !value?.models?.length) { say(result?.error?.message ?? "未获取到模型", false); return; }
        // 已探测的思考档位映射与手填的规格不会被这一步抹掉（config-service.upsertAiModel 只改传入字段）。
        // 接口声明的上下文窗口**只填空缺**：你手填过的值代表你的判断，不该被一次重新拉取覆盖掉。
        let filled = 0;
        for (const model of value.models) {
          const existing = provider.models.find((candidate) => candidate.id === model.id);
          const fillContext = model.contextWindow !== undefined && existing?.contextWindow === undefined;
          if (fillContext) filled += 1;
          await ipcInvoke("ai.model.upsert", {
            providerId: provider.id,
            modelId: model.id,
            modelName: model.name,
            ...(fillContext ? { contextWindow: model.contextWindow } : {}),
          });
        }
        aiNote(`已获取 ${value.models.length} 个真实模型${filled ? `，其中 ${filled} 个带回了上下文窗口` : "（接口未声明上下文窗口，需手填）"}`, true);
        refresh();
      });
    };
    const addModel = detailEl.querySelector<HTMLElement>("[data-m-add]");
    if (addModel) addModel.onclick = () => {
      const modelId = window.prompt("模型 id（与服务商接口一致）");
      if (!modelId?.trim()) return;
      void ipcInvoke("ai.model.upsert", { providerId: provider.id, modelId: modelId.trim(), modelName: modelId.trim() }).then((result) => {
        aiNote(result?.ok ? `已添加模型：${modelId.trim()}` : "添加失败", Boolean(result?.ok));
        refresh();
      });
    };
    const testBtn = detailEl.querySelector<HTMLElement>("[data-test]");
    if (testBtn) testBtn.onclick = () => {
      const model = currentModelId ? `${provider.id}/${currentModelId}` : (provider.models[0] ? `${provider.id}/${provider.models[0].id}` : undefined);
      say("测试中…", true);
      void ipcInvoke("ai.test", { workspaceId, model }).then((result) => {
        const value = (result?.ok ? result.value : undefined) as { ok?: boolean; message?: string; model?: string } | undefined;
        if (!result?.ok || !value) { say("测试失败", false); return; }
        // 一次真实调用的结论——标题栏的「连接正常/失败」只认这个，不认「有密钥」
        if (value.model) recordProbe({ ok: value.ok === true, model: value.model });
        say(value.ok ? `✓ ${value.message ?? "连接成功"}（${value.model ?? ""}）` : `✗ ${value.message ?? "连接失败"}`, value.ok === true);
      });
    };
    const deleteProvider = detailEl.querySelector<HTMLElement>("[data-p-del]");
    if (deleteProvider) deleteProvider.onclick = () => {
      void ipcInvoke("ai.provider.delete", { providerId: provider.id }).then((result) => {
        aiNote(result?.ok ? `服务商已删除：${provider.id}` : "删除失败", Boolean(result?.ok));
        aiActiveProvider = "";
        refresh();
      });
    };
    const openConfig = detailEl.querySelector<HTMLElement>("[data-open-config]");
    if (openConfig) openConfig.onclick = () => {
      void ipcInvoke("ai.config.open", { kind: "models" }).then((result) => {
        aiNote(result?.ok ? "已打开 ~/.lightee/models.json（保存后即时生效）" : "打开配置文件失败", Boolean(result?.ok));
      });
    };

    // —— 当前模型的三个思考强度（工作区级设置，跟着当前模型走）——
    if (currentModel) {
      const bind = (command: string, currentValue: string): void => {
        const select = detailEl.querySelector<HTMLSelectElement>(`[data-t-write="${command}"]`);
        renderThinkingOptions(select, currentModel.thinkingLevelMap, currentValue);
        if (!select) return;
        select.onchange = () => {
          void ipcInvoke(command, { workspaceId, thinking: select.value }).then((result) => {
            aiNote(result?.ok ? `思考档位：${select.value}` : "保存失败", Boolean(result?.ok));
          });
        };
      };
      // 缺省 high（作者裁定 2026-08-13）：默认面向质量，嫌费钱再手动降档。
      // 只剩这一档——审校档随全书审校一起休眠，术语档已随融合式提取取消。
      bind("ai.thinking.write", listValue?.currentThinking ?? "high");
    }
  }

  // 「上次编辑」卡：读取最近 session → 工作区/章节 → 原文译文预览
  async function renderLastEditCard(workspaces: WorkspaceRecord[]): Promise<void> {
    const card = document.getElementById("wc-last");
    if (!card) return;
    const body = card.querySelector<HTMLElement>(".wc-body");
    const head = card.querySelector<HTMLElement>(".wc-head span:not(:first-child)");
    if (!body) return;
    const session = await adapter.session();
    const workspace = session ? workspaces.find((w) => w.id === session.workspaceId) ?? null : null;
    if (!session || !workspace) {
      head && (head.textContent = "尚未开始编辑");
      body.innerHTML = `<div style="font-size:12px;color:var(--dimmer);padding:8px 2px">还没有编辑记录。打开或新建工作区后开始翻译。</div>`;
      return;
    }
    const chapter = workspace.volumes.flatMap((v) => v.chapters).find((c) => c.id === session.chapterId);
    const title = chapter?.title ?? session.chapterId;
    const time = new Date(session.savedAt).toLocaleString("zh-CN", { hour12: false });
    // 加载章节预览（原文/译文首段）
    let ja = "", zh = "";
    const loaded = await adapter.loadChapter(workspace.id, session.chapterId);
    if (loaded.ok && loaded.content.paragraphs.length > 0) {
      const first = loaded.content.paragraphs[0]!;
      ja = first.source.slice(0, 60);
      zh = first.translation.slice(0, 60);
    }
    if (head) head.textContent = `${title} · ${time}`;
    // 预览读不到时整块不摆：两栏空白像坏掉的卡；按钮照常给，进入本身不依赖预览
    const preview = ja || zh ? `
      <div style="display:flex;gap:14px;align-items:flex-start">
        <div style="flex:1">
          <div style="font-size:11px;color:var(--dimmer);margin-bottom:4px">原文 ja</div>
          <div style="color:var(--dimmer);font-size:13px">${escapeHtml(ja)}</div>
        </div>
        <div style="flex:1">
          <div style="font-size:11px;color:var(--accent);margin-bottom:4px">译文 zh · 可编辑</div>
          <div style="color:var(--text);font-size:14px">${escapeHtml(zh)}</div>
        </div>
      </div>` : "";
    body.innerHTML = `${preview}
      <div style="margin-top:10px;display:flex;gap:8px">
        <span class="wc-btn primary" id="wc-last-continue" style="cursor:pointer">↩ 从这句继续</span>
        <span class="wc-btn" id="wc-last-enter" style="cursor:pointer">进入工作台</span>
      </div>`;
    const continueBtn = document.getElementById("wc-last-continue");
    const enterBtn = document.getElementById("wc-last-enter");
    // 「从这句继续”与「进入工作台」走同一条路：enterWorkbench 本来就会恢复
    // session 里的章节（resumeChapter 读的正是 session.chapterId）。
    // 从前这里还额外 setTimeout(200) 去点侧栏条目——那次点击落在装配中途，
    // 与挂载自己的开章互相打架，正是「编辑器挂载护栏触发」的来源。重复动作删掉。
    if (continueBtn) continueBtn.onclick = () => void enterWorkbench(workspace.id);
    if (enterBtn) enterBtn.onclick = () => void enterWorkbench(workspace.id);
  }

  /**
   * 最近一次真实 LLM 调用的结论。标题栏的「连接正常/失败」只由它决定——
   * 「有密钥」推不出「连得上」，没有依据时不许亮绿灯（model-indicator.ts 的规则）。
   */
  let lastProbe: ProbeResult | null = null;
  function recordProbe(probe: ProbeResult): void {
    lastProbe = probe;
    void fillTitlebar(activeWorkspace?.name ?? null);
  }

  /**
   * 写入「当前用哪个模型」。四个入口都必须从这里走：Agent 控制台的模型下拉、
   * AI 快捷设置、模型列表的「使用」、标题栏选单。
   *
   * 因为换模型不只是写一行配置——右上角那格显示的是**当前链路**，模型变了它就得跟着变，
   * 而且旧的连通性探测结论一并作废（见 model-indicator.ts）。从前这件事靠四个调用点
   * 各自记得补一句 fillTitlebar，结果三处记得、Agent 控制台那处忘了：在控制台里换完模型，
   * 右上角还挂着上一个模型的名字，两处显示互相矛盾。
   */
  async function writeActiveModel(workspaceId: string, ref: string): Promise<{ ok: boolean; message?: string }> {
    const api = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<{ ok?: boolean; error?: { message?: string } }> } }).lightee;
    const result = await api?.invoke("ai.model.write", { workspaceId, model: ref });
    if (result?.ok) await fillTitlebar(activeWorkspace?.name ?? null);
    return { ok: Boolean(result?.ok), message: result?.error?.message };
  }

  type ProvidersListValue = { providers?: IndicatorProvider[]; current?: string };
  type ProvidersListResult = { ok: boolean; value?: ProvidersListValue } | undefined;

  async function fillTitlebar(workspaceName: string | null): Promise<void> {
    const token = workbenchContext.capture("workspace", "titlebar");
    // 左：真实工作区名（无则“主页”）
    const contextStrong = document.querySelector(".titlebar-context strong");
    if (contextStrong) contextStrong.textContent = workspaceName ?? "主页";
    // 右：真实当前模型 + 可证明的连接状态（异步读工作区 ai.model；主页用最近工作区）
    const host = document.getElementById("bar-status");
    const nameSpan = document.getElementById("tb-model-name");
    const connSpan = document.getElementById("tb-conn");
    if (!host || !nameSpan || !connSpan) return;
    let wsId = activeWorkspace?.id ?? "";
    if (!wsId) {
      const ws = await resolveSettingsWorkspace();
      wsId = ws?.id ?? "";
    }
    const lightee = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<ProvidersListResult> } }).lightee;
    void lightee?.invoke("ai.providers.list", { workspaceId: wsId }).then((r: ProvidersListResult) => {
      if (!workbenchContext.accepts(token)) return;
      const value = r?.ok ? r.value : undefined;
      const view = describeModelIndicator({
        current: value?.current ?? "",
        providers: value?.providers ?? [],
        lastProbe,
      });
      nameSpan.textContent = view.modelLabel;
      connSpan.textContent = view.connectionLabel;
      host.dataset.state = view.state;
      renderTitlebarMenu(view.options, wsId);
    });
  }

  /** 模型菜单：切模型直接写工作区配置，另留一条去设置面板的路（增删服务商/填密钥在那边） */
  function renderTitlebarMenu(options: IndicatorOption[], workspaceId: string): void {
    const button = document.getElementById("tb-model");
    const menu = document.getElementById("tb-menu");
    if (!button || !menu) return;
    const close = (): void => {
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
    };
    const groups = new Map<string, IndicatorOption[]>();
    for (const option of options) {
      const bucket = groups.get(option.providerName);
      if (bucket) bucket.push(option);
      else groups.set(option.providerName, [option]);
    }
    const rows: string[] = [];
    for (const [providerName, items] of groups) {
      rows.push(`<div class="tb-menu-group">${escapeHtml(providerName)}</div>`);
      for (const item of items) {
        rows.push(`<button type="button" class="tb-menu-item" role="menuitem" data-ref="${escapeHtml(item.ref)}">`
          + `<span class="tb-check">${item.current ? "✓" : ""}</span>`
          + `<span>${escapeHtml(item.modelName)}</span>`
          + `${item.needsKey ? '<span class="tb-warn">需要密钥</span>' : ""}`
          + `</button>`);
      }
    }
    if (rows.length === 0) rows.push(`<div class="tb-menu-empty">还没有配置任何服务商。到设置里添加服务商并填入 API 密钥。</div>`);
    menu.innerHTML = rows.join("")
      + `<div class="tb-menu-sep"></div>`
      + `<button type="button" class="tb-menu-item" role="menuitem" data-ai-settings><span class="tb-check"></span><span>AI 服务商设置…</span></button>`;

    menu.querySelectorAll<HTMLElement>("[data-ref]").forEach((item) => {
      item.onclick = () => {
        close();
        const ref = item.dataset.ref ?? "";
        if (!workspaceId || !ref) return;
        void writeActiveModel(workspaceId, ref).then((written) => {
          runtimeWindow.pushEvent?.(written.ok ? `模型：${ref}` : `模型保存失败：${written.message ?? ""}`, written.ok ? "ok" : "err");
        });
      };
    });
    const settingsItem = menu.querySelector<HTMLElement>("[data-ai-settings]");
    if (settingsItem) settingsItem.onclick = () => {
      close();
      // openAiSettings 直接停在「模型 · 服务商」那一格；老版本 shell 只有 openSettings 时退回它。
      const shell = window as BridgeWindow & { openAiSettings?: () => void; openSettings?: () => void };
      if (shell.openAiSettings) shell.openAiSettings();
      else shell.openSettings?.();
    };

    // 事件绑定每次重建菜单都要重来；用 onclick 而非 addEventListener，避免重复叠加。
    button.onclick = (event) => {
      event.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      button.setAttribute("aria-expanded", open ? "true" : "false");
    };
    document.addEventListener("click", (event) => {
      if (menu.hidden) return;
      if (!menu.contains(event.target as Node) && event.target !== button) close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !menu.hidden) close();
    });
  }

  /**
   * 选到一个还不是工作区的目录时给出的出路。
   *
   * 从前这里是条死路：后端报「缺少 book.yaml」，界面照抄一句报错，作者手上只有一个
   * 空目录和一个不肯打开它的按钮。就地初始化是安全的——createWorkspaceSkeleton 只
   * 建目录、只在 book.yaml / manifest.json **不存在时**才写，既有文件一个字节都不动。
   */
  function offerWorkspaceInit(path: string): Promise<string | null> {
    return new Promise((resolve) => {
      const folder = path.split(/[\\/]/).filter(Boolean).pop() ?? "未命名工作区";
      const overlay = document.createElement("div");
      overlay.className = "nc-modal-overlay";
      overlay.innerHTML = `
        <div class="nc-modal">
          <div class="nc-modal-head">这个目录还不是工作区</div>
          <p class="nc-modal-note">${escapeHtml(path)}</p>
          <p class="nc-modal-note">要在这里新建一个吗？会建出 Lightee 的目录结构，目录里已有的文件不会被改动。</p>
          <label class="nc-field"><span>书名</span><input id="ws-init-name" class="nc-input" type="text" value="${escapeHtml(folder)}" /></label>
          <div class="nc-modal-actions">
            <button type="button" class="nc-btn" id="ws-init-cancel">取消</button>
            <button type="button" class="nc-btn primary" id="ws-init-confirm">在这里新建</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const nameInput = overlay.querySelector<HTMLInputElement>("#ws-init-name");
      let settled = false;
      const close = (value: string | null): void => {
        if (settled) return;
        settled = true;
        overlay.remove();
        resolve(value);
      };
      overlay.querySelector<HTMLElement>("#ws-init-confirm")?.addEventListener("click", () => close(nameInput?.value.trim() || folder));
      overlay.querySelector<HTMLElement>("#ws-init-cancel")?.addEventListener("click", () => close(null));
      overlay.addEventListener("click", (event) => { if (event.target === overlay) close(null); });
      overlay.addEventListener("keydown", (event) => {
        if (event.key === "Escape") close(null);
        if (event.key === "Enter") { event.preventDefault(); close(nameInput?.value.trim() || folder); }
      });
      nameInput?.focus();
      nameInput?.select();
    });
  }

  async function openWorkspacePicker(): Promise<void> {
    const path = await adapter.pickDirectory();
    if (!path) return;
    const result = await adapter.open(path);
    if (result.ok) {
      // 已经建在同步盘上的工作区：木已成舟，拦下来没有意义，但得让作者知道
      // 「译文偶尔退回旧版本」将来会有个已知的出处。真正拦一道的是新建那条路。
      const provider = detectSyncFolder(path);
      if (provider) runtimeWindow.pushEvent?.(`这个工作区在 ${provider} 的同步文件夹里，同步可能让译文退回旧版本`, "act");
      await enterWorkbench(result.workspace.id);
      return;
    }
    if (!result.notAWorkspace) {
      runtimeWindow.pushEvent?.(`打开工作区失败：${result.message}`, "err");
      return;
    }
    const name = await offerWorkspaceInit(path);
    if (name === null) { runtimeWindow.pushEvent?.("已取消：这个目录还不是工作区", "act"); return; }
    await createWorkspaceAt(path, name);
  }

  async function createWorkspaceFlow(): Promise<void> {
    const path = await adapter.pickDirectory();
    if (!path) return;
    await createWorkspaceAt(path, path.split(/[\\/]/).filter(Boolean).pop() ?? "未命名工作区");
  }

  /**
   * 选中的位置在云同步文件夹里时的确认。
   *
   * 拦在**新建**这一步，因为这是位置还能改的最后一刻——建完再迁移就得连同术语快照、
   * 草稿、章节状态一起搬，而作者通常是在译文莫名退版之后才想起这回事。
   *
   * 默认按钮是「换个位置」：这里推荐的动作是撤回，不是继续。
   */
  function confirmSyncFolder(path: string, provider: string): Promise<boolean> {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "nc-modal-overlay";
      overlay.innerHTML = `
        <div class="nc-modal">
          <div class="nc-modal-head">这个位置在 ${escapeHtml(provider)} 的同步文件夹里</div>
          <p class="nc-modal-note">${escapeHtml(path)}</p>
          <p class="nc-modal-note">工作区会被持续读写。同步软件在后台改动文件时，可能让译文退回到旧版本，而且不容易察觉。建议换一个本地磁盘上的位置。</p>
          <p class="nc-modal-note">要备份请用应用内的「导出工作区归档」，它打包成单个 .zip 文件，那才是同步软件能正确处理的东西。</p>
          <div class="nc-modal-actions">
            <button type="button" class="nc-btn" id="ws-sync-continue">仍然用这里</button>
            <button type="button" class="nc-btn primary" id="ws-sync-cancel">换个位置</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      let settled = false;
      const close = (value: boolean): void => {
        if (settled) return;
        settled = true;
        overlay.remove();
        resolve(value);
      };
      overlay.querySelector<HTMLElement>("#ws-sync-continue")?.addEventListener("click", () => close(true));
      overlay.querySelector<HTMLElement>("#ws-sync-cancel")?.addEventListener("click", () => close(false));
      overlay.addEventListener("click", (event) => { if (event.target === overlay) close(false); });
      overlay.addEventListener("keydown", (event) => { if (event.key === "Escape") close(false); });
      overlay.querySelector<HTMLElement>("#ws-sync-cancel")?.focus();
    });
  }

  async function createWorkspaceAt(path: string, name: string): Promise<void> {
    const provider = detectSyncFolder(path);
    if (provider && !(await confirmSyncFolder(path, provider))) {
      runtimeWindow.pushEvent?.("已取消：请换一个本地磁盘上的位置", "act");
      return;
    }
    const result = await adapter.create({ path, name });
    if (!result.ok) {
      runtimeWindow.pushEvent?.(`新建工作区失败：${result.message}`, "err");
      return;
    }
    runtimeWindow.pushEvent?.(`已新建工作区《${name}》`, "ok");
    await enterWorkbench(result.workspace.id);
  }

  /**
   * 工作台装配期间把舞台藏起来，装完一次性揭幕。
   *
   * 进入工作区要依次落地十多次可见变更：stage 整块重画、侧栏重画、tab 翻转、
   * 面板换内容、书名与标题栏（异步）、书籍切换器（异步）、侧栏术语/进度/主按钮/
   * 徽标（各自异步）、最后面板从「加载中」换成编辑器。每一步都看得见，合起来
   * 就是一次抽搐。装配顺序本身没问题——问题是把装配过程演给了作者看。
   *
   * 用 opacity 而不是 display/visibility：后两者会改变布局或可测量性，
   * 而装配途中有代码要量几何（moveCursor 的两阶段校正）。
   *
   * 返回的 reveal 幂等，且**自带超时兜底**：装配途中任何一条早退路径都不许把
   * 界面永远留在不可见状态——看不见的界面比抖一下严重得多。
   */
  function beginStageMount(stage: HTMLElement): () => void {
    stage.classList.remove("ws-mounted");
    stage.classList.add("ws-mounting");
    let revealed = false;
    const reveal = (): void => {
      if (revealed) return;
      revealed = true;
      stage.classList.remove("ws-mounting");
      stage.classList.add("ws-mounted");
    };
    window.setTimeout(reveal, 1500);
    return reveal;
  }

  async function enterWorkbench(workspaceId: string): Promise<void> {
    const navigationToken = workbenchContext.beginNavigation();
    if (activeWorkspace?.id !== workspaceId && !await leaveEditorSession()) return;
    if (!workbenchContext.acceptsNavigation(navigationToken)) return;
    const list = await adapter.list();
    if (!workbenchContext.acceptsNavigation(navigationToken)) return;
    const workspace = list.find((candidate) => candidate.id === workspaceId) ?? null;
    if (!workspace) {
      runtimeWindow.pushEvent?.("工作区不存在", "err");
      return;
    }
    if (workspace.status === "missing" || workspace.status === "invalid") {
      runtimeWindow.pushEvent?.(`工作区不可用：${workspace.error ?? "目录已删除或移动"}`, "err");
      runtimeWindow.showToast?.(workspace.status === "missing" ? "工作区缺失：目录不存在" : "工作区无效", { duration: 3200 });
      return;
    }
    activeWorkspace = workspace;
    // 跨工作区残影：activeChapterContent 属于上一个工作区，不清掉的话，
    // 从这里到本函数末尾 openChapterSafely(首章) 之间的任何护栏/render-panel 钩子
    // 都会拿旧 chapterId 配新工作区 id 去加载章节——切进章节集不同的工作区
    // 直接「Unknown chapter」（2026-08-14 实测：从 203 章的书切进单章演示工作区）。
    // leaveEditorSession 只管保存与销毁会话，不管这个快照。
    if (activeChapterContent && activeChapterContent.workspaceId !== workspace.id) {
      activeChapterContent = null;
      needsChapterReload = false;
    }
    // RS-2：换工作区 → 命令栏勾选回默认，跑批视图清空（它属于上一个工作区；
    // 切回去时本工作区的下一条 chapter-started 事件足以重建 k/N 视图）
    composerSelection = null;
    composerOpen = false;
    scopeRun = null;
    transitionContext(workspace.id, null, "bi");
    const stage = document.getElementById("stage");
    if (!stage || typeof runtimeWindow.renderMain !== "function") return;
    const revealStage = beginStageMount(stage);
    stage.innerHTML = runtimeWindow.renderMain();
    // 空工作区（没有任何章节）→ 正文区显示导入引导
    const emptyWorkspace = workspace.volumes.every((volume) => volume.chapters.length === 0);
    if (emptyWorkspace) {
      const panel = document.getElementById("bpanel");
      if (panel) renderEmptyWorkspaceGuide(panel);
      // 空工作区默认激活「正文编辑」tab（demo 默认是术语 tab）
      const biTab = document.querySelector<HTMLElement>("[data-btab=\"bi\"]");
      if (biTab) {
        document.querySelectorAll<HTMLElement>("[data-btab]").forEach((t) => { t.classList.remove("on"); t.setAttribute("aria-selected", "false"); });
        biTab.classList.add("on");
        biTab.setAttribute("aria-selected", "true");
      }
    }
    const chapterList = document.getElementById("chapter-list");
    if (chapterList) {
      chapterList.innerHTML = renderChapterList(workspace);
      bindVolumeToggles();
    }
    // 侧栏拖拽导入：设计稿 show() 未走（bridge 直接渲染），需手动绑定
    runtimeWindow.bindSideDrop?.();
    // 非空工作区默认激活「正文编辑」tab（stage 重建后 demo 可能默认 terms → bindTabs 会先渲染术语页并覆盖编辑器）
    if (!emptyWorkspace) {
      const biTab = document.querySelector<HTMLElement>("[data-btab=\"bi\"]");
      if (biTab && !biTab.classList.contains("on")) {
        document.querySelectorAll<HTMLElement>("[data-btab]").forEach((t) => { t.classList.remove("on"); t.setAttribute("aria-selected", "false"); });
        biTab.classList.add("on");
        biTab.setAttribute("aria-selected", "true");
      }
    }
    // 顶部工作流选项卡：bridge 绕过 show() → bindTabs 未执行 → tab 点击瘫痪。绑定一次。
    // 注意：hook 必须先于 bindTabs 注册——bindTabs 内部立即调用 renderPanel()，
    // 若 hook 未就位会闪现设计稿 demo 分段编辑器（820px 居中、ce-block 小黑边框、type-cursor 光标）。
    if (!(window as BridgeWindow & { __tabBound?: boolean }).__tabBound) {
      (window as BridgeWindow & { __tabBound?: boolean }).__tabBound = true;
      // 注册 renderPanel hook：bTab=bi 时一律由 bridge 接管（无章节时保持占位，不渲染 demo）；
      // 已有真实编辑器则不重复重建（保护未保存编辑）
      (window as BridgeWindow & { __lighteeRenderPanelHook?: () => boolean }).__lighteeRenderPanelHook = () => {
        const activeTab = activeBtab() ?? "bi";
        const ownedTab = workbenchContext.current().tab ?? "bi";
        if (activeTab !== ownedTab && !tabTransitionInFlight) {
          restoreTabSelection(ownedTab);
          void selectWorkbenchTab(activeTab);
          return true;
        }
        if (activeWorkspace && activeWorkspace.volumes.every((volume) => volume.chapters.length === 0)) {
          // 空工作区：正文区显示导入引导（无论当前 tab，避免 demo 术语页覆盖）
          const panel = document.getElementById("bpanel");
          if (panel) renderEmptyWorkspaceGuide(panel);
          return true;
        }
        if (activeTab === "bi" && activeWorkspace) {
          // 章节快照必须属于当前工作区——残影走「无章节」分支落回首章，而不是拿旧
          // chapterId 配新工作区 id 去撞 Unknown chapter
          if (activeChapterContent && activeChapterContent.workspaceId === activeWorkspace.id) {
            const host = document.getElementById("chapter-editor-host");
            // 会话已被销毁（空壳 host 仍在 DOM 中）同样必须重建——判据与 openChapterSafely 一致
            if (!host || !editorSession || needsChapterReload) {
              void openChapterSafely(activeWorkspace.id, activeChapterContent.chapterId)
                .then(() => ensureEditorInvariant("render-panel"));
            } else {
              ensureEditorInvariant("render-panel");
            }
          } else {
            const chapters = activeWorkspace.volumes.flatMap((volume) => volume.chapters);
            if (chapters[0]) {
              void openChapterSafely(activeWorkspace.id, chapters[0].id)
                .then(() => ensureEditorInvariant("render-panel"));
            } else {
              // 有工作区但一个章节都没有：渲染空工作区引导，绝不把 bi 让回 ui-shell-runtime
              // （设计 §2：bi 的所有权是 bridge 独占，hook 对 bi 必须无条件返回 true）
              const panel = document.getElementById("bpanel");
              if (panel) renderEmptyWorkspaceGuide(panel);
            }
          }
          return true;
        }
        if (activeTab === "terms" && activeWorkspace) {
          // 阶段 B：真实术语确认页（confirm.list / confirm.decide）
          void renderTermsPanel(activeWorkspace.id);
          void updateTermBadge(activeWorkspace.id);
          return true;
        }
        if (activeTab === "review" && activeWorkspace) {
          // 审校 tab：真实 review.run（阶段 C，替代 demo REVIEW_ISSUES）
          void renderReviewPanel(activeWorkspace.id);
          return true;
        }
        if (activeTab === "agent" && activeWorkspace) {
          // Agent 控制台 tab：真实 LLM 调用日志 + Agent 状态
          void renderAgentConsole();
          return true;
        }
        return false;
      };
    }
    // 每次进入工作区重建 stage 后重新绑定 tab（新 tab 元素无 onclick）——否则术语/审校 tab 点击瘫痪
    runtimeWindow.bindTabs?.();
    bindProtectedTabs();
    const bookMeta = document.querySelector(".book-meta");
    if (bookMeta) bookMeta.textContent = `${workspace.name} · ${workspace.path}`;
    bindShortcutsPanel();
    bindAiEvents();
    overrideStartTranslate();
    overrideRealExport();
    // 标题栏：真实工作区名 + 真实当前模型（异步）
    await fillTitlebar(workspace.name);
    if (!workbenchContext.acceptsNavigation(navigationToken)) return;
    await renderBookSwitcher();
    if (!workbenchContext.acceptsNavigation(navigationToken)) return;
    updateRealStatusBar();
    // Agent 控制台：初始渲染（真实 LLM 调用日志）
    void renderAgentConsole();
    // 侧栏真实化：术语表 + 进度/token + footer 主按钮
    void renderSideTerms();
    void updateSideFoot();
    void updateMainActButton();
    // 术语徽标必须在这里再刷一次：工作台骨架（含 tab 栏）是本函数里重建的，
    // 骨架带的是中性占位「–」，早于它跑的那次 updateTermBadge 会被整段覆盖掉。
    // 症状是徽标停在「–」，直到用户点一下术语 tab 才跳成真实状态。
    void updateTermBadge(workspace.id);
    // 打开上次编辑的章节（session 恢复）：优先 session 中章节，缺省用首个章节
    const session = await adapter.session();
    if (!workbenchContext.acceptsNavigation(navigationToken) || activeWorkspace?.id !== workspace.id) return;
    const allChapters = workspace.volumes.flatMap((volume) => volume.chapters);
    const resumeChapter = session && session.workspaceId === workspace.id
      ? allChapters.find((chapter) => chapter.id === session.chapterId)
      : undefined;
    const targetChapter = resumeChapter ?? workspace.volumes[0]?.chapters[0];
    if (targetChapter && typeof runtimeWindow.openChapter === "function") {
      runtimeWindow.openChapter(targetChapter.id);
      // 默认切到「正文编辑」tab（作者自翻零门禁；避免停在 demo 术语页导致 activeChapterContent 为空、AI 按钮/点击无反应）
      const biTab = document.querySelector<HTMLElement>("[data-btab=\"bi\"]");
      if (biTab && !biTab.classList.contains("on")) {
        document.querySelectorAll<HTMLElement>("[data-btab]").forEach((t) => { t.classList.remove("on"); t.setAttribute("aria-selected", "false"); });
        biTab.classList.add("on");
        biTab.setAttribute("aria-selected", "true");
        // 这里**不能**调 renderPanel()：它会触发 render-panel 钩子，而钩子在没有章节
        // 快照时会自作主张去开首章——紧接着下面又开一次，同一章被并发加载两遍，
        // 先发起的那次被后一次顶掉，报「渲染序号已过期」。下一行就是真正的打开，
        // 由它一次做到位。
      }
      // 加载真实章节内容到右侧编辑器（全宽连续输入 + 原文对照）。
      // 这里 await：揭幕要等正文就位，否则作者看到的仍是「空面板 → 编辑器」两跳。
      if (activeWorkspace) await openChapterSafely(activeWorkspace.id, targetChapter.id);
      // 上次编辑的**段落**：恢复的是位置而不只是章。会话里记了光标所在段时，
      // 编辑器挂载完直接落回那一段（滚到视野中央 + 落光标）；没记或段落已不存在
      // （revealParagraph 返回 false）则维持默认的章首，不做进一步猜测。
      if (resumeChapter && session?.paragraphId && activeWorkspace?.id === workspace.id) {
        chapterEditor?.revealParagraph(session.paragraphId);
      }
      // 双阶段校正：60ms 快速定位 + 320ms 动画(volItemIn .22s)结束后精确校正，消除进入错位（滑动而非闪现）
      setTimeout(() => runtimeWindow.moveCursor?.(), 60);
      setTimeout(() => runtimeWindow.moveCursor?.(), 320);
    }
    // 装配完成，揭幕。放在最后一行：此前任何一次可见变更都还在幕布后面。
    revealStage();
  }

  function closeBookSwitcher(box: HTMLElement): void {
    document.querySelectorAll<HTMLElement>('.cs-panel[data-owner="book-switcher"]').forEach((panel) => panel.remove());
    box.classList.remove("open");
  }

  // 侧栏书栏下拉：渲染真实工作区列表（替换设计稿 demo BOOKS），点击切换 + 缩回
  async function renderBookSwitcher(): Promise<void> {
    const box = document.getElementById("cs-book");
    if (!box) return;
    const workspaces = await adapter.list();
    const current = activeWorkspace?.id ?? "";
    const cur = workspaces.find((workspace) => workspace.id === current);
    const trig = `<span class="trig-title" title="${escapeHtml(cur?.name ?? "工作区")}">${escapeHtml(cur?.name ?? "选择工作区")}</span>`;
    closeBookSwitcher(box);
    box.innerHTML = `<span class="cs-trig">${trig}<span class="arr">▼</span></span>`;
    const trigEl = box.querySelector(".cs-trig");
    if (!trigEl) return;
    trigEl.addEventListener("click", (event) => {
      event.stopPropagation();
      // 展开状态由本组件拥有；单击当前触发器必须立即收起。
      if (box.classList.contains("open")) {
        closeBookSwitcher(box);
        return;
      }
      runtimeWindow.closeAllCs?.();
      box.classList.add("open");
      renderBookPanel(box, workspaces, current);
    });
  }

  /**
   * 把条目从「最近工作区」列表里移除。
   *
   * 只动注册表，**不碰磁盘**——目录还在的工作区移除后仍可用「打开」加回来。
   * 注册表刻意保留目录已消失的条目（静默过滤会让工作区无声消失），但看得见不等于
   * 删不掉：没有出口，失效条目就永远堆着（作者实测）。这里就是那个出口。
   */
  async function forgetWorkspaces(ids: readonly string[]): Promise<void> {
    const api = (window as BridgeWindow & { lightee?: { invoke: (c: string, p: unknown) => Promise<{ ok: boolean; error?: { message?: string } }> } }).lightee;
    let removed = 0;
    for (const id of ids) {
      if (!id) continue;
      const result = await api?.invoke("workspace.forget", { workspaceId: id });
      if (result?.ok) removed += 1;
      else runtimeWindow.pushEvent?.(`移除失败：${result?.error?.message ?? id}`, "err");
    }
    if (removed > 0) {
      runtimeWindow.pushEvent?.(`已从最近列表移除 ${removed} 个工作区（磁盘文件未动）`, "ok");
      await renderDashboard();
    }
  }

  function renderBookPanel(box: HTMLElement, workspaces: WorkspaceRecord[], current: string): void {
    const panel = document.createElement("div");
    panel.className = "cs-panel";
    panel.dataset.owner = "book-switcher";
    panel.innerHTML = workspaces.map((workspace) => {
      const missing = workspace.status === "missing" || workspace.status === "invalid";
      return `<div class="cs-item ${workspace.id === current ? "sel" : ""}${missing ? " muted" : ""}" data-v="${escapeHtml(workspace.id)}" title="${escapeHtml(missing ? "目录已删除或移动" : workspace.path)}">${escapeHtml(workspace.name)}${missing ? `<span class="sub">缺失</span>` : `<span class="sub">${escapeHtml(workspace.path)}</span>`}</div>`;
    }).join("");
    const rect = box.querySelector(".cs-trig")?.getBoundingClientRect();
    if (rect) {
      panel.style.top = `${rect.bottom + 4}px`;
      panel.style.left = `${rect.left}px`;
    }
    document.body.appendChild(panel);
    panel.querySelectorAll(".cs-item").forEach((item) => {
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        const id = (item as HTMLElement).dataset.v;
        closeBookSwitcher(box);
        if (id && id !== activeWorkspace?.id) void enterWorkbench(id);
      });
    });
  }

  async function backToDashboard(): Promise<void> {
    workbenchContext.beginNavigation();
    if (!await leaveEditorSession()) return;
    activeWorkspace = null;
    activeChapterContent = null;
    needsChapterReload = false;
    transitionContext(null, null, null);
    const stage = document.getElementById("stage");
    if (!stage || typeof runtimeWindow.renderDash !== "function") return;
    stage.innerHTML = runtimeWindow.renderDash();
    await renderDashboard();
    // 返回主页：标题栏切回主页态（工作区名 → 主页）
    void fillTitlebar(null);
  }

  // 活动流撤销委托：data-undo-id = trashId
  if (!(window as BridgeWindow).__bridgeUndoBound) {
    (window as BridgeWindow).__bridgeUndoBound = true;
    document.addEventListener("click", (event) => {
      const undo = (event.target as HTMLElement).closest<HTMLElement>("[data-action=\"undo\"]");
      if (!undo || !undo.dataset.undoId) return;
      event.preventDefault();
      const kind = undo.dataset.undoKind ?? "chapter";
      const workspaceId = undo.dataset.undoWorkspace ?? activeWorkspace?.id;
      if (!workspaceId) return;
      void (kind === "volume" ? restoreVolume(workspaceId, undo.dataset.undoId!) : restoreChapter(workspaceId, undo.dataset.undoId!));
    });
  }

  const bridge: WorkspaceBridge = {
    adapter,
    refreshDashboard: renderDashboard,
    openWorkspacePicker,
    createWorkspaceFlow,
    enterWorkbench,
    backToDashboard,
    getCurrentWorkspace: () => activeWorkspace,
    getVolumes: () => (activeWorkspace?.volumes ?? []).map((volume) => ({
      id: volume.id,
      name: volume.name,
      chapters: volume.chapters.map((chapter) => ({ chapterId: chapter.id, title: chapter.title })),
    })),
    createChapter,
    deleteChapter,
    deleteVolume,
    moveChapter: async (chapterId, targetVolumeId, afterChapterId) => {
      if (!activeWorkspace) return;
      const workspaceId = activeWorkspace.id;
      const result = await adapter.moveChapter(workspaceId, chapterId, targetVolumeId, afterChapterId);
      if (result.ok && activeWorkspace?.id === workspaceId) await refreshTree();
    },
    updateEditorSettings,
    runChapterCheck,
  };
  runtimeWindow.__lighteeWorkspaceBridge = bridge;
  /**
   * 关窗保存提示（RH-13）。复用既有 `save-hint` 的措辞语汇，不引入新的视觉语言；
   * 写在标题栏是因为此刻编辑器可能已经不在视野里（用户可能停在术语/审校 tab）。
   */
  function showClosingHint(): void {
    const title = document.querySelector<HTMLElement>(".book-meta") ?? document.getElementById("titlebar-title");
    if (title && !title.dataset.closingHint) {
      title.dataset.closingHint = "1";
      title.textContent = "正在保存…";
    }
    const hint = document.getElementById("save-hint");
    if (hint) { hint.textContent = "正在保存…"; hint.dataset.tone = "busy"; }
  }

  // 关窗排空握手（RH-04 / DEF-04）：主进程发 will-close → 这里把防抖中的编辑立即落盘 → 回执。
  // flush 失败/冲突也必须回执：数据已尽力持久化（草稿或冲突态），不能因此让窗口关不掉。
  const closeApi = (window as BridgeWindow & {
    lightee?: {
      onWillClose?: (listener: () => void) => () => void;
      closeReady?: () => void;
      onUpdateReady?: (listener: () => void) => () => void;
    };
  }).lightee;
  // 新版下载完（打包版才有）。装是退出时自动装的，但这件事必须说出来——
  // 一直开着应用的人否则永远不知道有新版本在等着。
  closeApi?.onUpdateReady?.(() => {
    runtimeWindow.pushEvent?.("新版本已下载，下次退出应用时自动装上", "ok");
    runtimeWindow.showToast?.("新版本已下载，下次退出应用时自动装上", { duration: 6000 });
  });
  closeApi?.onWillClose?.(() => {
    // RH-13：排空可能要等 autosave 防抖 + 一次写盘。没有任何反馈时，用户看到的是
    // 「点了关闭但窗口不动」——那和卡死无法区分。极快时一闪而过也没关系，不做人为延时。
    showClosingHint();
    void (async () => {
      try {
        if (!await flushEditorSession()) runtimeWindow.pushEvent?.("关闭前仍有未保存的修改（已保留在草稿中）", "err");
      } catch {
        runtimeWindow.pushEvent?.("关闭前排空编辑失败", "err");
      } finally {
        closeApi?.closeReady?.();
      }
    })();
  });
  // 主页态：标题栏接真实信息（工作区名 + 当前模型）
  void fillTitlebar(null);
  // Agent 控制台 tab：激活时每 2s 拉取最新 LLM 调用日志
  window.setInterval(() => {
    const agentTab = document.querySelector("[data-btab=\"agent\"].on");
    if (agentTab) void renderAgentConsole();
  }, 2000);
  // 快捷键面板切换入口（footer「快捷键」chip）
  (window as BridgeWindow & { __lighteeToggleShortcuts?: () => void }).__lighteeToggleShortcuts = () => {
    if (document.getElementById("shortcuts-overlay")) hideShortcutsPanel();
    else showShortcutsPanel();
  };
  // 编辑器视觉设置全局入口（设计稿设置面板 / 测试调用）
  installTranslationGuideBridge();
  (window as BridgeWindow & { __lighteeEditorSettings?: (patch: Parameters<typeof updateEditorSettings>[0]) => Promise<boolean> }).__lighteeEditorSettings = (patch) => updateEditorSettings(patch);
  (window as BridgeWindow & { __lighteeReadEditorSettings?: () => Promise<{ ok: boolean; settings?: Parameters<typeof updateEditorSettings>[0] }> }).__lighteeReadEditorSettings = async () => {
    const target = await resolveSettingsWorkspace();
    if (!target) return { ok: false };
    const read = await adapter.readEditorSettings(target.id);
    if (!read.ok) return { ok: false };
    return { ok: true, settings: read.settings };
  };
  return bridge;
}
