/**
 * TUI 状态逻辑（可测试，与渲染分离）。
 */

export type ChapterUIState = "imported" | "ready" | "translating" | "translated" | "reviewing" | "revising" | "approved" | "stuck";

export interface ChapterStatusUI {
  id: string;
  title: string;
  state: ChapterUIState;
}

export type TuiView = "list" | "detail";

export interface TuiState {
  chapters: ChapterStatusUI[];
  selectedIndex: number;
  view: TuiView;
  /** 事件日志（最近 N 条） */
  log: string[];
  /** 当前章节的译文（detail 视图显示/编辑） */
  currentTranslation: string;
}

export interface TranslateDeps {
  translate: (chapterId: string) => Promise<{ translation: string; drifts: unknown[]; pendingTerms: unknown[] }>;
}

export function createTuiState(chapters: ChapterStatusUI[]): TuiState {
  return {
    chapters,
    selectedIndex: 0,
    view: "list",
    log: [],
    currentTranslation: "",
  };
}

export function moveSelection(s: TuiState, dir: "up" | "down"): TuiState {
  const n = s.chapters.length;
  if (n === 0) return s;
  const delta = dir === "down" ? 1 : -1;
  return { ...s, selectedIndex: (s.selectedIndex + delta + n) % n };
}

export function setView(s: TuiState, view: TuiView): TuiState {
  return { ...s, view };
}

export function selectedChapter(s: TuiState): ChapterStatusUI | undefined {
  return s.chapters[s.selectedIndex];
}

export function log(s: TuiState, msg: string): TuiState {
  return { ...s, log: [...s.log, `[${new Date().toLocaleTimeString()}] ${msg}`].slice(-20) };
}

/** 翻译当前选中章节 */
export async function translateChapter(s: TuiState, deps: TranslateDeps): Promise<TuiState> {
  const ch = selectedChapter(s);
  if (!ch) return s;
  if (ch.state !== "ready" && ch.state !== "translated") {
    return log(s, `ch${ch.id} 状态 ${ch.state} 不可翻译`);
  }

  let next = updateChapter(s, ch.id, "translating");
  next = log(next, `开始翻译 ${ch.title}`);
  try {
    const res = await deps.translate(ch.id);
    next = updateChapter(next, ch.id, "translated");
    next = { ...next, currentTranslation: res.translation };
    return log(next, `✅ ${ch.title} 翻译完成`);
  } catch (e) {
    next = updateChapter(next, ch.id, "ready");
    return log(next, `❌ ${ch.title} 失败: ${(e as Error).message}`);
  }
}

export function updateChapter(s: TuiState, id: string, state: ChapterUIState): TuiState {
  return {
    ...s,
    chapters: s.chapters.map((c) => (c.id === id ? { ...c, state } : c)),
  };
}

export function stats(s: TuiState): { approved: number; total: number; percent: number } {
  const total = s.chapters.length;
  const approved = s.chapters.filter((c) => c.state === "approved").length;
  return { approved, total, percent: total === 0 ? 0 : Math.round((approved / total) * 100) };
}
