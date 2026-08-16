/**
 * 导出构成（RV-07 第 3/5 条）。
 *
 * 后端在 RV-07 里已经把两道门禁拆掉了：导出永远可点，拿不到的唯一原因只能是
 * 那部分真的还没译。渲染层当时没跟上——面板仍按「章节 approved」与「全书审校通过」
 * 置灰按钮，于是作者看到的产品行为还是被挡着的。这个模块是新的判据来源。
 *
 * 纯函数、无 DOM：renderer 的 vitest 环境是 node，能单测的逻辑必须和 DOM 读写分开。
 */

export type ExportChapterState =
  | "imported" | "ready" | "translating" | "translated"
  | "reviewing" | "revising" | "approved" | "stuck";

export interface ExportChapter {
  id: string;
  title: string;
  state?: ExportChapterState;
}

export interface ExportComposition {
  /** 已定稿 */
  done: ExportChapter[];
  /** 有译文但作者还没定稿——导出读暂存稿 */
  draft: ExportChapter[];
  /** 一个字都还没有 */
  missing: ExportChapter[];
}

/**
 * 状态到三堆的映射。`translating` 归「尚无译文」：正在翻不等于已经有译文，
 * 把它算进可导出会让作者以为成品里有这一章。缺 state 同理按最保守的一堆算。
 */
export function composeExport(chapters: ReadonlyArray<ExportChapter>): ExportComposition {
  const done: ExportChapter[] = [];
  const draft: ExportChapter[] = [];
  const missing: ExportChapter[] = [];
  for (const chapter of chapters) {
    if (chapter.state === "approved") done.push(chapter);
    else if (chapter.state === "translated" || chapter.state === "reviewing" || chapter.state === "revising" || chapter.state === "stuck") draft.push(chapter);
    else missing.push(chapter);
  }
  return { done, draft, missing };
}

/** 为零的那一段不出现——「0 章尚无译文」占着位置却不携带信息。 */
export function describeComposition(summary: ExportComposition): string {
  const parts: string[] = [];
  if (summary.done.length > 0) parts.push(`${summary.done.length} 章已完成`);
  if (summary.draft.length > 0) parts.push(`${summary.draft.length} 章有译文未完成`);
  if (summary.missing.length > 0) parts.push(`${summary.missing.length} 章尚无译文`);
  return parts.length > 0 ? parts.join(" · ") : "这个工作区还没有章节";
}

/**
 * 唯一还成立的拦截理由：真的没有东西可导。
 * approved 与全书审校**都不再是条件**——后端已经不看了，界面再看就是替一个
 * 不存在的规则站岗。
 */
export function exportBlockReason(
  scope: "current" | "book" | "pick",
  summary: ExportComposition,
  activeChapter: ExportChapter | undefined,
  picked?: ReadonlyArray<string>,
): string | undefined {
  if (scope === "pick") {
    // 一章没勾就不是「导不出」，是还没说要导什么——两者的提示必须不一样。
    if (!picked || picked.length === 0) return "先勾选要导出的章节";
    const withText = new Set([...summary.done, ...summary.draft].map((chapter) => chapter.id));
    return picked.some((id) => withText.has(id)) ? undefined : "勾选的章节都还没有译文";
  }
  if (scope === "book") {
    return summary.done.length + summary.draft.length > 0 ? undefined : "这本书还没有任何译文";
  }
  if (!activeChapter) return "请先打开要导出的章节";
  return summary.missing.some((chapter) => chapter.id === activeChapter.id) ? "这一章还没有译文" : undefined;
}

/**
 * 能批量标记完成的只有 `stuck`——它是唯一一个卡在机器判定上、等作者拍板的状态
 * （`chapter.accept` 的定义域）。其余状态要么已经完成，要么还在流程里，
 * 替作者「标记」它们等于替他做了没做过的决定。
 */
export function acceptableChapters(chapters: ReadonlyArray<ExportChapter>): ExportChapter[] {
  return chapters.filter((chapter) => chapter.state === "stuck");
}

export interface ExportOutcome {
  exported?: string[];
  fromStaging?: string[];
  skipped?: string[];
}

/**
 * 导出完成后的如实说明。跳过的章节要报章名：作者拿到的成品少了东西，
 * 只给个数字他没法知道少的是哪一章。
 */
export function describeExportResult(outcome: ExportOutcome, chapters: ReadonlyArray<ExportChapter>): string {
  if (!outcome.exported) return "已导出";
  const parts = [`已导出 ${outcome.exported.length} 章`];
  if (outcome.fromStaging && outcome.fromStaging.length > 0) parts.push(`其中 ${outcome.fromStaging.length} 章来自暂存稿`);
  if (outcome.skipped && outcome.skipped.length > 0) {
    const titleOf = (id: string): string => chapters.find((chapter) => chapter.id === id)?.title ?? id;
    parts.push(`跳过 ${outcome.skipped.length} 章尚无译文：${outcome.skipped.map(titleOf).join("、")}`);
  }
  return parts.join(" · ");
}
