/**
 * Lightee TUI —— pi 式聊天工作台。
 *
 * 布局（垂直堆叠）:
 *   Text 标题 → Text 消息区（命令输出）→ Input 命令输入 → Text 状态行
 *
 * 命令（在输入框输入，Enter 执行）:
 *   /help · /list · /open <ch> · /translate <ch> · /edit <ch>
 *   /terms · /review <ch> · /export <ch> · /status · /quit
 *
 * 编辑（/edit）: pi 常规编辑器（方向键/退格/undo），Esc 返回 · Ctrl+S 保存
 */

import {
  TUI,
  ProcessTerminal,
  Text,
  Input,
  Editor,
  Loader,
  matchesKey,
  Key,
  wrapTextWithAnsi,
  type EditorTheme,
} from "@earendil-works/pi-tui";

// ===== ANSI 配色 =====
const CYAN = (s: string) => `\x1b[36m${s}\x1b[0m`;
const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;
const MAGENTA = (s: string) => `\x1b[35m${s}\x1b[0m`;

const editorTheme: EditorTheme = {
  borderColor: (s) => CYAN(s),
  selectList: {
    selectedPrefix: (s) => `${YELLOW("❯")} ${s}`,
    selectedText: (s) => CYAN(s),
    description: (s) => DIM(s),
    scrollInfo: (s) => DIM(s),
    noMatch: (s) => YELLOW(s),
  },
};

// ===== 类型 =====
export interface TuiChapter {
  id: string;
  title: string;
  state: string;
  volume?: string;
}

export interface TuiDeps {
  workspacePath?: string;
  /** 加载已有译文（真实：读 translations/{id}_zh.md） */
  loadTranslation?: (chapterId: string) => Promise<string | null>;
  /** 翻译单章（真实：Translator + 落盘） */
  translate?: (chapterId: string) => Promise<{ translation: string }>;
  /** 内核调度翻译（runPipeline 状态机 + Manager 仲裁 + 事件流）——与 CLI 严格对齐 */
  translateAll?: (
    ids: string[],
    onEvent: (event: string) => void
  ) => Promise<{ approved: string[]; stuck: string[] }>;
  /** 读原文（对照显示用） */
  loadSource?: (chapterId: string) => Promise<string>;
  /** 导出（真实：写 output/） */
  exportChapter?: (chapterId: string, format: string) => Promise<{ outPath: string; exported: string[]; fromStaging: string[]; skipped: string[] }>;
  /** 单章审校（真实：reviewer-scan L0/L1） */
  reviewChapter?: (chapterId: string) => Promise<{ issueCount: number; issues: Array<{ type: string; severity: string; found?: string }> }>;
  /** 导出进度（/export 提示用） */
  exportProgress?: () => Promise<{ total: number; done: number }>;
  /** 导入文件（.epub/.txt/.md） */
  importFile?: (path: string, volumeId?: string) => Promise<{ chapters: Array<{ id: string; title: string; volume: string }> }>;
  /** 导入预览（dry-run 分章，E1 确认前展示） */
  previewImport?: (path: string) => Promise<{
    ext: string;
    chapters: Array<{ title: string; charCount: number; needsManualConfirm?: boolean }>;
    volumeHint?: string;
  }>;
  /** 分步导入：开始会话（volumeId 可选：默认下一卷，指定 = 追加已有卷） */
  beginStep?: (volumeId?: string) => Promise<{ volumeId: string; volumeLabel: string }>;
  /** 分步导入：提交章节（volumeId = 会话卷） */
  finishStep?: (volumeId: string, chapters: Array<{ title: string; content: string }>) => Promise<{ chapters: Array<{ id: string; title: string; volume: string }> }>;
  /** 设置读写（E2: /settings 显示 · /set 修改持久化） */
  settings?: {
    read: () => Promise<Record<string, unknown>>;
    write: (key: string, value: string) => Promise<boolean>;
  };
}

const STATE_ICON: Record<string, string> = {
  approved: "✔",
  translated: "◈",
  translating: "⏳",
  ready: "◇",
  imported: "○",
  revising: "↻",
  reviewing: "◎",
  stuck: "✖",
};

const HELP_TEXT = [
  `${CYAN("/list")}             章节列表`,
  `${CYAN("/open")} <ch>       查看章节译文（如 /open ch002）`,
  `${CYAN("/translate")} <ch>  翻译章节`,
  `${CYAN("/edit")} <ch>       编辑译文（Esc 返回 · Ctrl+S 保存）`,
  `${CYAN("/review")} <ch>     审校章节`,
  `${CYAN("/terms")}           术语表`,
  `${CYAN("/export")} <ch>     导出章节`,
  `${CYAN("/status")}          引擎状态`,
  `${CYAN("/quit")}            退出（或 Ctrl+Q）`,
].join("\n");

// ===== 主入口 =====
export async function runTui(chapters: TuiChapter[], deps: TuiDeps = {}): Promise<void> {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  // ---- 组件 ----
  const title = new Text(`\n  ${CYAN("✦")} lightee  ${DIM("— 聊天工作台")}\n`);
  const log = new Text(DIM("输入 /help 查看可用命令"));
  const input = new Input();
  const status = new Text("");
  const loader = new Loader(tui, CYAN, DIM, "翻译中…");

  tui.addChild(title);
  tui.addChild(log);
  tui.addChild(input);
  tui.addChild(status);
  tui.setFocus(input);

  // ---- 状态 ----
  const messages: Array<{ kind: "cmd" | "out" | "ok" | "err" | "warn"; text: string }> = [];
  let currentId = chapters[0]?.id ?? "";
  let editing = false;
  const translationCache = new Map<string, string>();

  // ---- 消息区渲染（wrap + 滚动保留最近 24 行）----
  const renderLog = () => {
    const width = tui.terminal.columns;
    const lines: string[] = [];
    for (const m of messages) {
      const prefix = m.kind === "cmd" ? `${CYAN("❯")} ` : m.kind === "err" ? "  " : m.kind === "ok" ? `${GREEN("✓")} ` : m.kind === "warn" ? `${YELLOW("⚠")} ` : "  ";
      const color = m.kind === "err" ? RED : m.kind === "ok" ? GREEN : m.kind === "warn" ? YELLOW : m.kind === "out" ? (s: string) => s : DIM;
      for (const line of m.text.split("\n")) {
        lines.push(color(prefix + line));
      }
    }
    // wrap 到终端宽度（留 2 边距），保留最近 24 行
    const wrapped: string[] = [];
    for (const line of lines) {
      for (const wl of wrapTextWithAnsi(line, Math.max(20, width - 4))) wrapped.push(wl);
    }
    log.setText("\n" + wrapped.slice(-24).join("\n") + "\n");
    tui.requestRender();
  };

  const logMsg = (kind: "cmd" | "out" | "ok" | "err" | "warn", text: string) => {
    messages.push({ kind, text });
    if (messages.length > 60) messages.splice(0, messages.length - 60);
    renderLog();
  };

  const chapterById = (id: string) => chapters.find((c) => c.id === id);

  // ---- 加载译文 ----
  const loadTranslation = async (id: string): Promise<string | null> => {
    if (translationCache.has(id)) return translationCache.get(id)!;
    if (deps.loadTranslation) {
      const tr = await deps.loadTranslation(id);
      if (tr) translationCache.set(id, tr);
      return tr;
    }
    return null;
  };

  // ---- 分步导入状态机（/import step）----
  let stepSession: { volumeId: string; volumeLabel: string; chapters: Array<{ title: string; content: string }> } | null = null;
  let stepPhase: "volume" | "content" | "title" | "confirm" | null = null;
  let stepBuffer = "";

  const stepPrompt = (): string => {
    if (stepPhase === "volume") return "卷（Enter = 新建「" + (stepSession?.volumeLabel ?? "第一卷") + "」· 输入 v01 等 = 追加已有卷）:";
    if (stepPhase === "content") return "粘贴章节内容（粘贴后单独一行输入 // 结束 · c 完成）:";
    if (stepPhase === "title") return "章节名（Enter = 自动「第N章」）:";
    if (stepPhase === "confirm") return "汇总确认中 — [Enter] 确认导入 [d+序号] 删除 [Esc] 取消";
    return "";
  };

  const stepSummary = (): string => {
    const s = stepSession!;
    const rows = s.chapters.map((c, i) => `  ${s.volumeId} ch${String(i + 1).padStart(3, "0")} ${c.title} · ${c.content.length} 字`).join("\n");
    return `── 导入一卷（${s.volumeLabel}）──\n${rows || "  （还没有章节）"}\n[Enter 确认导入] [d+序号 删除] [Esc 取消]`;
  };

  const renderStepStatus = () => {
    status.setText(`\n${CYAN(stepPrompt())}\n`);
    tui.requestRender();
  };

  // ---- 导入预览模式（/import <路径> → 预览 → Enter 确认）----
  let importPreviewPath: string | null = null;

  // ---- 术语裁决模式（/confirm 驱动，复用 confirm-session）----
  let confirmSession: import("./confirm-session.ts").ConfirmSession | null = null;
  const handleCommand = async (raw: string) => {
    const parts = raw.trim().split(/\s+/, 2);
    const cmd0 = (parts[0] ?? "").toLowerCase();
    const arg = (parts[1] ?? "").trim();
    const target = arg || currentId;
    logMsg("cmd", raw.trim());

    switch (cmd0) {
      case "/help":
        logMsg("out", HELP_TEXT);
        break;

      case "/list": {
        const list = chapters
          .map((c) => `  ${STATE_ICON[c.state] ?? "○"} ${c.id}  ${c.title}${c.id === currentId ? DIM("  ← 当前") : ""}`)
          .join("\n");
        logMsg("out", list || "（无章节）");
        break;
      }

      case "/open": {
        const ch = chapterById(target);
        if (!ch) {
          logMsg("err", `未知章节 ${target}（/list 查看）`);
          break;
        }
        currentId = ch.id;
        const tr = await loadTranslation(ch.id);
        const body = tr
          ? tr.slice(0, 600) + (tr.length > 600 ? DIM("\n…（截断，/edit 查看全文）") : "")
          : DIM("（本章还没有译文 — /translate 翻译）");
        logMsg("out", `${YELLOW("──")} ${ch.id} ${ch.title} ${YELLOW("──")}\n${body}`);
        break;
      }

      case "/translate": {
        const ch = chapterById(target);
        if (!ch && target !== "all") {
          logMsg("err", `未知章节 ${target}`);
          break;
        }
        if (!deps.translateAll) {
          logMsg("warn", "翻译调度未接入（CLI 中可用）");
          break;
        }
        const ids = target === "all" ? chapters.map((c) => c.id) : [target];
        currentId = ids[0] ?? currentId;
        logMsg("out", `⛭ Manager: 开始任务（${ids.length} 章 · 状态机调度）`);
        try {
          const r = await deps.translateAll(ids, (ev) => logMsg("out", `⛭ ${ev}`));
          logMsg(
            "out",
            `⛭ Manager: 完成 — ${GREEN("approved: " + (r.approved.join(", ") || "无"))}${r.stuck.length ? ` · ${RED("stuck: " + r.stuck.join(", "))}` : ""}`
          );
          // 翻译完成 → 自动对照（首章前 3 段）+ 提示
          const firstId = r.approved[0] ?? r.stuck[0];
          if (firstId && deps.loadTranslation && deps.loadSource) {
            const [tr, src] = await Promise.all([deps.loadTranslation(firstId), deps.loadSource(firstId)]);
            if (tr && src) {
              const srcParas = src.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
              const trParas = tr.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
              const pairs: string[] = [];
              for (let i = 0; i < Math.min(3, srcParas.length, trParas.length); i++) {
                pairs.push(`  ${DIM(srcParas[i]!.slice(0, 40))}\n  ${trParas[i]!.slice(0, 40)}`);
              }
              logMsg("out", `── 双语对照 ${firstId} ──\n${pairs.join("\n\n")}`);
              logMsg("out", `${DIM("/open " + firstId + " 查看全文对照")}`);
            }
          }
        } catch (e) {
          logMsg("err", `翻译调度失败: ${(e as Error).message}`);
        }
        break;
      }

      case "/edit": {
        const ch = chapterById(target);
        if (!ch) {
          logMsg("err", `未知章节 ${target}`);
          break;
        }
        currentId = ch.id;
        const tr = (await loadTranslation(ch.id)) ?? "";
        enterEditor(ch.id, tr);
        break;
      }

      case "/review": {
        const ch = chapterById(target);
        if (!ch) {
          logMsg("err", `未知章节 ${target}`);
          break;
        }
        if (!deps.reviewChapter) {
          logMsg("warn", "审校未接入（CLI 中可用）");
          break;
        }
        logMsg("out", `⏳ 审校 ${ch.id}…`);
        try {
          const r = await deps.reviewChapter(ch.id);
          if (r.issueCount === 0) {
            logMsg("ok", `${ch.id} 审校通过 — 无问题`);
          } else {
            const lines = r.issues.map((i) => `  ${i.severity === "high" ? "✗" : "⚠"} ${i.type}: ${i.found ?? ""}`);
            logMsg("warn", `${ch.id} 审校发现 ${r.issueCount} 个问题:\n${lines.join("\n")}`);
          }
        } catch (e) {
          logMsg("err", `审校失败: ${(e as Error).message}`);
        }
        break;
      }

      case "/terms":
        logMsg("out", DIM("术语表: 未接入（Terminologist 在 CLI 流水线中）"));
        break;

      case "/export": {
        if (!deps.exportChapter) {
          logMsg("warn", "导出未接入（CLI 中可用）");
          break;
        }
        const parts2 = raw.trim().split(/\s+/).slice(1);
        const isFmt = (x: string | undefined) => x === "epub" || x === "txt" || x === "md";
        const fmt = isFmt(parts2[1]) ? parts2[1]! : (isFmt(parts2[0]) ? parts2[0]! : "epub");
        const tgt = fmt === parts2[0] ? (parts2[1] ?? currentId) : (parts2[0] ?? currentId);
        if (tgt === "all" && deps.exportProgress) {
          const p = await deps.exportProgress();
          if (p.done < p.total) logMsg("warn", `仅 ${p.done}/${p.total} 章已翻译 — 未译章节将为空`);
        }
        logMsg("out", `⏳ 导出 ${tgt}（${fmt}）…`);
        try {
          const result = await deps.exportChapter(tgt, fmt);
          const skipNote = result.skipped.length > 0 ? `（跳过 ${result.skipped.length} 章尚无译文：${result.skipped.join(", ")}）` : "";
          logMsg("ok", `✓ 导出完成 → ${result.outPath}${skipNote}`);
        } catch (e) {
          logMsg("err", `导出失败: ${(e as Error).message}`);
        }
        break;
      }

      case "/import": {
        const sub = arg.split(/\s+/, 2)[0] ?? "";
        if (sub === "step") {
          if (!deps.beginStep) {
            logMsg("warn", "分步导入未接入（CLI 中可用）");
            break;
          }
          // 同步进入 volume 阶段（防 async 竞态），session 异步填充
          stepSession = { volumeId: "", volumeLabel: "加载中…", chapters: [] };
          stepPhase = "volume";
          renderStepStatus();
          const s = await deps.beginStep();
          if (stepPhase === "volume" && stepSession) {
            stepSession.volumeId = s.volumeId;
            stepSession.volumeLabel = s.volumeLabel;
            logMsg("out", `── 导入一卷 ── 默认「${s.volumeLabel}」`);
            renderStepStatus();
          }
        } else if (sub) {
          // /import <路径> → 先预览，Enter 确认后导入
          if (!deps.previewImport || !deps.importFile) {
            logMsg("warn", "文件导入未接入（CLI 中可用）");
            break;
          }
          try {
            const preview = await deps.previewImport(sub);
            const warn = preview.chapters.filter((c) => c.needsManualConfirm);
            const lines = preview.chapters.map((c) => `  ${c.title} · ${c.charCount} 字${c.needsManualConfirm ? " ⚠" : ""}`);
            logMsg("out", `── 导入预览（${preview.ext}）${preview.volumeHint ? `→ ${preview.volumeHint}` : ""} ──\n${lines.join("\n")}`);
            if (warn.length > 0) {
              logMsg("warn", `${warn.length} 个章节标题未识别（将整段作为「本文」）— 确认后可用 /import step 手动分章`);
            }
            importPreviewPath = sub;
            logMsg("out", `${DIM("[Enter] 确认导入 · [c] 取消")}`);
          } catch (e) {
            logMsg("err", `预览失败: ${(e as Error).message}`);
          }
        } else {
          logMsg("err", "/import 用法: /import <路径> | /import step");
        }
        break;
      }

      // 分步导入阶段输入（非命令）
      case "__step__": {
        // 由输入分发处理
        break;
      }

      case "/cancel": {
        if (stepSession) {
          stepSession = null;
          stepPhase = null;
          stepBuffer = "";
          status.setText(`\n${DIM("[Ctrl+Q] 退出 · /help 查看命令")}\n`);
          logMsg("warn", "分步导入已取消");
        }
        break;
      }

      case "/settings": {
        if (!deps.settings) {
          logMsg("warn", "设置未接入（CLI 中可用）");
          break;
        }
        const s = await deps.settings.read();
        const fmt = (k: string, v: unknown) => `  ${CYAN(k)} = ${v}`;
        const lines = [
          fmt("quoteStyle", s.quoteStyle),
          fmt("contextWindow", s.contextWindow),
          fmt("translation.concurrency", (s.translation as Record<string, unknown>)?.concurrency),
          fmt("translation.batchChars", (s.translation as Record<string, unknown>)?.batchChars),
        ];
        logMsg("out", `── 设置 ──\n${lines.join("\n")}`);
        logMsg("out", `${DIM("修改: /set <键> <值>（如 /set quoteStyle jp）")}`);
        break;
      }

      case "/set": {
        if (!deps.settings) {
          logMsg("warn", "设置未接入（CLI 中可用）");
          break;
        }
        const [key, ...rest] = raw.trim().split(/\s+/).slice(1);
        const value = rest.join(" ");
        if (!key || !value) {
          logMsg("err", "/set 用法: /set <键> <值>（/settings 查看键）");
          break;
        }
        const ok = await deps.settings.write(key, value);
        if (ok) {
          logMsg("ok", `已设置 ${key} = ${value}（config.json 持久化）`);
        } else {
          logMsg("err", `未知设置项 ${key}（/settings 查看可用键）`);
        }
        break;
      }

      case "/confirm": {
        if (!deps.workspacePath) {
          logMsg("err", "没有工作区（无法读取决策卡）");
          break;
        }
        const { loadSession, currentCard, verdict, finishSession, parseAction, renderCard } = await import("./confirm-session.ts");
        const session = await loadSession({ root: deps.workspacePath });
        if (!session) {
          logMsg("warn", "没有待确认的决策卡（先运行 translate 生成）");
          break;
        }
        confirmSession = session;
        const card = currentCard(session);
        if (card) {
          logMsg("out", renderCard(card, session.index, session.cards.length));
          logMsg("out", `${DIM("[数字] 选候选 · m 译名 自定义 · s 跳过 · b 后退 · q 完成")}`);
        }
        break;
      }

      case "/status": {
        const ws = deps.workspacePath ? `\n${DIM(`工作区: ${deps.workspacePath}`)}` : "";
        const done = chapters.filter((c) => c.state === "approved" || c.state === "translated").length;
        logMsg("out", `章节 ${done}/${chapters.length} 已翻译${ws}`);
        break;
      }

      case "/quit":
      case "/exit":
        tui.stop();
        process.exit(0);
        break;

      default:
        logMsg("err", `未知命令 ${cmd0}（/help 查看）`);
    }
  };

  // ---- 编辑器（常规编辑，Esc 返回 · Ctrl+S 保存）----
  const editor = new Editor(tui, editorTheme);
  let editingId = "";

  const enterEditor = (id: string, text: string) => {
    editing = true;
    editingId = id;
    editor.setText(text);
    tui.addChild(editor);
    tui.setFocus(editor);
    status.setText(`\n${CYAN(`编辑 ${id}`)} ${DIM("· 方向键移动 · Ctrl+S 保存 · Esc 返回")}\n`);
    tui.requestRender();
  };

  const exitEditor = (saved: boolean) => {
    if (!editing) return;
    editing = false;
    if (saved) {
      const text = editor.getText();
      translationCache.set(editingId, text);
      logMsg("ok", `${editingId} 已保存 → translations/${editingId}_zh.md`);
    }
    tui.removeChild(editor);
    tui.setFocus(input);
    status.setText(`\n${DIM("[Ctrl+Q] 退出 · /help 查看命令")}\n`);
    tui.requestRender();
  };

  // ---- 键盘拦截（编辑器快捷键 + 全局退出）----
  tui.addInputListener((data) => {
    // 编辑器模式: Esc 返回 / Ctrl+S 保存（拦截，不传给 Editor）
    if (editing) {
      if (matchesKey(data, Key.escape)) {
        exitEditor(false);
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+s")) {
        exitEditor(true);
        return { consume: true };
      }
      return undefined;
    }
    // 分步导入: 空 Enter → 模拟提交（Input 组件忽略空值提交）
    if (stepPhase && (data === "\n" || data === "\r" || matchesKey(data, "enter")) && input.getValue().trim() === "") {
      void handleSubmit("");
      return { consume: true };
    }
    // 分步导入: Esc 取消
    if (stepPhase && matchesKey(data, Key.escape)) {
      stepSession = null;
      stepPhase = null;
      stepBuffer = "";
      status.setText(`\n${DIM("[Ctrl+Q] 退出 · /help 查看命令")}\n`);
      logMsg("warn", "分步导入已取消");
      return { consume: true };
    }
    // 全局: Ctrl+Q 退出
    if (matchesKey(data, "ctrl+q")) {
      tui.stop();
      process.exit(0);
      return { consume: true };
    }
    return undefined;
  });

  // ---- 命令提交 ----
  // ---- 输入分发（onSubmit + 空 Enter 拦截共用）----
  const handleSubmit = async (value: string) => {
    const v = value.trim();
    input.setValue("");

    // 分步导入阶段分发（空值也可推进阶段）
    if (stepPhase === "volume") {
      if (v === "/cancel") {
        stepSession = null;
        stepPhase = null;
        status.setText(`\n${DIM("[Ctrl+Q] 退出 · /help 查看命令")}\n`);
        logMsg("warn", "分步导入已取消");
      } else if (!stepSession!.volumeId) {
        // session 还在加载（beginStep await 中）→ 忽略本次输入
        logMsg("warn", "卷信息加载中，请稍候再输入…");
      } else {
        // 显式卷 id（追加已有卷）→ 重新开始会话；空 Enter = 用默认卷
        if (v && v !== stepSession!.volumeId && deps.beginStep) {
          const s = await deps.beginStep(v);
          if (stepPhase === "volume" && stepSession) {
            stepSession = { volumeId: s.volumeId, volumeLabel: s.volumeLabel, chapters: [] };
          }
        }
        stepPhase = "content";
        renderStepStatus();
      }
      return;
    }
    if (stepPhase === "content") {
      if (v === "//") {
        // 内容结束 → 问章节名
        stepPhase = "title";
        renderStepStatus();
      } else if (v === "c") {
        // 完成 → 汇总确认
        stepPhase = "confirm";
        logMsg("out", stepSummary());
        renderStepStatus();
      } else if (v === "/cancel") {
        stepSession = null;
        stepPhase = null;
        stepBuffer = "";
        status.setText(`\n${DIM("[Ctrl+Q] 退出 · /help 查看命令")}\n`);
        logMsg("warn", "分步导入已取消");
      } else {
        // 追加内容（可多次粘贴）
        stepBuffer += (stepBuffer ? "\n\n" : "") + v;
        logMsg("cmd", `（+${v.length} 字符）`);
        logMsg("out", `已收 ${stepBuffer.length} 字符 — 继续粘贴或输入 ${CYAN("//")} 结束`);
      }
      return;
    }
    if (stepPhase === "title") {
      const title = v === "/cancel" ? "" : v;
      if (v === "/cancel") {
        stepSession = null;
        stepPhase = null;
        stepBuffer = "";
        status.setText(`\n${DIM("[Ctrl+Q] 退出 · /help 查看命令")}\n`);
        logMsg("warn", "分步导入已取消");
        return;
      }
      const autoTitle = `第${stepSession!.chapters.length + 1}章`;
      stepSession!.chapters.push({ title: title || autoTitle, content: stepBuffer });
      stepBuffer = "";
      logMsg("ok", `✓ 已添加 ${stepSession!.volumeId} 第${stepSession!.chapters.length}章「${title || autoTitle}」· ${stepSession!.chapters[stepSession!.chapters.length - 1]!.content.length} 字`);
      stepPhase = "content";
      renderStepStatus();
      return;
    }
    if (stepPhase === "confirm") {
      if (v === "/cancel") {
        stepSession = null;
        stepPhase = null;
        stepBuffer = "";
        status.setText(`\n${DIM("[Ctrl+Q] 退出 · /help 查看命令")}\n`);
        logMsg("warn", "分步导入已取消");
        return;
      }
      const dm = /^d(\d+)$/.exec(v);
      if (dm) {
        const idx = parseInt(dm[1]!, 10) - 1;
        if (idx >= 0 && idx < stepSession!.chapters.length) {
          const removed = stepSession!.chapters.splice(idx, 1)[0]!;
          logMsg("warn", `已删除「${removed.title}」`);
          logMsg("out", stepSummary());
        } else {
          logMsg("err", `序号超出范围（1-${stepSession!.chapters.length}）`);
        }
        renderStepStatus();
        return;
      }
      if (v === "" || v === "y" || v === "yes") {
        // 确认导入（Enter）：先退出阶段防竞态，再异步落盘
        const s = stepSession;
        stepSession = null;
        stepPhase = null;
        stepBuffer = "";
        if (!s || s.chapters.length === 0) {
          logMsg("err", "没有章节可导入");
          status.setText(`\n${DIM("[Ctrl+Q] 退出 · /help 查看命令")}\n`);
          tui.requestRender();
          return;
        }
        if (deps.finishStep) {
          try {
            const res = await deps.finishStep(s.volumeId, s.chapters);
            // 刷新本地章节列表
            for (const c of res.chapters) {
              if (!chapters.some((x) => x.id === c.id && x.volume === c.volume)) {
                chapters.push({ id: c.id, title: c.title, state: "imported", volume: c.volume });
              }
            }
            logMsg("ok", `✓ 导入完成 — ${res.chapters.length} 章 → source/${s.volumeId}/`);
            logMsg("out", `/list 查看 · /open ${res.chapters[0]?.id ?? ""} 打开`);
          } catch (e) {
            logMsg("err", `导入失败: ${(e as Error).message}`);
          }
        } else {
          logMsg("warn", "分步导入未接入（CLI 中可用）");
        }
        status.setText(`\n${DIM("[Ctrl+Q] 退出 · /help 查看命令")}\n`);
        tui.requestRender();
        return;
      }
      logMsg("err", "[Enter] 确认 · [d+序号] 删除 · [Esc]/[/cancel] 取消");
      return;
    }

    // 导入预览模式：Enter 确认导入 / c 取消
    if (importPreviewPath) {
      if (v === "c" || v === "/cancel") {
        importPreviewPath = null;
        logMsg("warn", "导入已取消");
      } else if (v === "" || v === "y" || v === "yes") {
        const path = importPreviewPath;
        importPreviewPath = null;
        if (deps.importFile) {
          try {
            const res = await deps.importFile(path);
            logMsg("ok", `✓ 导入完成 — ${res.chapters.length} 章（${res.chapters[0]?.volume ?? ""}）`);
            for (const c of res.chapters) {
              if (!chapters.some((x) => x.id === c.id && x.volume === c.volume)) {
                chapters.push({ id: c.id, title: c.title, state: "imported", volume: c.volume });
              }
            }
            logMsg("out", `/list 查看 · /open ${res.chapters[0]?.id ?? ""} 打开`);
          } catch (e) {
            logMsg("err", `导入失败: ${(e as Error).message}`);
          }
        }
      } else {
        logMsg("err", "[Enter] 确认导入 · [c] 取消");
      }
      return;
    }

    // 术语裁决模式：输入解析为裁决
    if (confirmSession) {
      const { currentCard, verdict, finishSession, parseAction, renderCard } = await import("./confirm-session.ts");
      const card = currentCard(confirmSession);
      if (v === "q" || v === "/cancel") {
        const idx = confirmSession.index;
        const total = confirmSession.cards.length;
        confirmSession = null;
        status.setText(`\n${DIM("[Ctrl+Q] 退出 · /help 查看命令")}\n`);
        logMsg("warn", `裁决进度已保存（${idx}/${total}）— /confirm 继续`);
        return;
      }
      if (!card) {
        // 全部完成 → 应用
        const ws = { root: deps.workspacePath ?? "" };
        try {
          const applied = await finishSession(ws, confirmSession);
          logMsg("ok", `✅ 已确认 ${applied.length} 项 → terminology/（translate --confirm 直接使用）`);
        } catch (e) {
          logMsg("err", `应用裁决失败: ${(e as Error).message}`);
        }
        confirmSession = null;
        status.setText(`\n${DIM("[Ctrl+Q] 退出 · /help 查看命令")}\n`);
        tui.requestRender();
        return;
      }
      const action = parseAction(v, card);
      if (!action) {
        logMsg("err", "无法识别: [1-9] / m 译名 / s / b / q");
        return;
      }
      if (action.action === "back") {
        if (confirmSession.index > 0) {
          confirmSession.index -= 1;
          confirmSession.verdicts.pop();
          const { saveSession } = await import("./confirm-session.ts");
          await saveSession({ root: deps.workspacePath ?? "" }, confirmSession);
          const cur = currentCard(confirmSession);
          if (cur) logMsg("out", renderCard(cur, confirmSession.index, confirmSession.cards.length));
        }
        return;
      }
      if (action.action === "quit") return;
      await verdict({ root: deps.workspacePath ?? "" }, confirmSession, {
        action: action.action,
        chosenZh: action.action === "skip" ? undefined : action.chosenZh,
      });
      const next = currentCard(confirmSession);
      if (next) {
        logMsg("out", renderCard(next, confirmSession.index, confirmSession.cards.length));
      } else {
        const ws = { root: deps.workspacePath ?? "" };
        try {
          const applied = await finishSession(ws, confirmSession);
          logMsg("ok", `✅ 已确认 ${applied.length} 项 → terminology/`);
        } catch (e) {
          logMsg("err", `应用裁决失败: ${(e as Error).message}`);
        }
        confirmSession = null;
        status.setText(`\n${DIM("[Ctrl+Q] 退出 · /help 查看命令")}\n`);
        tui.requestRender();
      }
      return;
    }

    if (!v) return;
    void handleCommand(v);
  };

  input.onSubmit = (value) => {
    void handleSubmit(value);
  };

  // ---- 启动 ----
  renderLog();
  status.setText(`\n${DIM("[Ctrl+Q] 退出 · /help 查看命令")}\n`);
  logMsg("out", `${GREEN("✦ lightee 就绪")}  ${DIM(chapters.length + " 个章节 · " + (deps.workspacePath ?? ""))}`);
  tui.start();
}
