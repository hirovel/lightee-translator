/**
 * 翻译范围选择模型（RS-2 / TP-RS 批 D4、D5、D10）。
 *
 * 纯函数：勾选状态 → 意图清单与摘要行。DOM 由 workspace-bridge 画，
 * 这里只回答三个问题——默认勾谁、谁可以勾、勾完之后如实说清要干什么。
 */

export interface ScopeChapterOption {
  chapterId: string;
  title: string;
  /** ChapterWorkflowState；旧数据可能没有 → 视为未译 */
  state?: string;
}

export interface ScopePlanChapter {
  chapterId: string;
  /** 勾选时已是已译章 → 显式重译（D4）。开工前复核据此不因 approved 跳过 */
  retranslate?: boolean;
}

export interface ScopeSummary {
  /** 勾选章数 */
  count: number;
  /** 其中显式重译的章数 */
  retranslate: number;
  /** 其中 stuck 重跑的章数 */
  stuck: number;
  /**
   * 摘要行（D4：如实显示「含重译 N」，不加确认弹窗；D10：不编预估数字，
   * 只说时长视模型思考量而定）。没勾任何章时给出引导语。
   */
  text: string;
  /** 交给 translate.runScope 的意图清单（保持章节树顺序） */
  chapters: ScopePlanChapter[];
}

/** 已完成翻译的状态（勾选它 = 显式重译） */
const DONE_STATES = new Set(["approved", "translated"]);
/** 正在被别的任务处理——勾了也会被主进程开工前复核跳过，UI 直接禁勾 */
const IN_FLIGHT_STATES = new Set(["translating", "reviewing", "revising"]);

export function isDoneState(state: string | undefined): boolean {
  return state !== undefined && DONE_STATES.has(state);
}

export function isInFlightState(state: string | undefined): boolean {
  return state !== undefined && IN_FLIGHT_STATES.has(state);
}

/** 默认勾选：未译章全选（D4）。stuck 默认不勾（D5），已译不勾，飞行中不可勾 */
export function defaultSelection(options: ReadonlyArray<ScopeChapterOption>): Set<string> {
  const selected = new Set<string>();
  for (const option of options) {
    if (isDoneState(option.state) || isInFlightState(option.state) || option.state === "stuck") continue;
    selected.add(option.chapterId);
  }
  return selected;
}

/** stuck 章清单（D5 的「含 stuck ×N」一键补勾数据源） */
export function stuckChapterIds(options: ReadonlyArray<ScopeChapterOption>): string[] {
  return options.filter((option) => option.state === "stuck").map((option) => option.chapterId);
}

export function summarizeSelection(
  options: ReadonlyArray<ScopeChapterOption>,
  selected: ReadonlySet<string>,
): ScopeSummary {
  const chapters: ScopePlanChapter[] = [];
  let retranslate = 0;
  let stuck = 0;
  for (const option of options) {
    if (!selected.has(option.chapterId)) continue;
    // 飞行中的章不进清单：主进程会跳过它，但让它出现在「将翻译 N 章」里就是谎报范围
    if (isInFlightState(option.state)) continue;
    if (isDoneState(option.state)) {
      retranslate += 1;
      chapters.push({ chapterId: option.chapterId, retranslate: true });
      continue;
    }
    if (option.state === "stuck") stuck += 1;
    chapters.push({ chapterId: option.chapterId });
  }
  if (chapters.length === 0) {
    return { count: 0, retranslate: 0, stuck: 0, chapters, text: "未选择章节——勾选要翻译的章" };
  }
  const parts = [`将翻译 ${chapters.length} 章`];
  if (retranslate > 0) parts.push(`含重译 ${retranslate}`);
  if (stuck > 0) parts.push(`含 stuck ×${stuck}（重跑即重置）`);
  // D10：思考量跨模型不稳定，编一个预估数字只会制造「它算错了」的体验
  parts.push("时长视模型思考量而定");
  return { count: chapters.length, retranslate, stuck, chapters, text: parts.join(" · ") };
}
