/**
 * 章节状态机 —— 8 态流转，advance_state 是查表式合法性校验。
 *
 * 状态权威在文件系统（chapter_state.json），任何写入方只能通过
 * advanceState 推进，非法转移直接拒绝。LLM 不直接改状态。
 */

export const CHAPTER_STATES = [
  "imported",     // 原文已导入（BookSource 解析完成）
  "ready",        // 术语就绪，可翻译
  "translating",  // 翻译中（Translator 持有，排他）
  "translated",   // 译文已落盘
  "reviewing",    // 审校中
  "revising",     // 修订中（收到修订单）
  "approved",     // 无 high 级问题，通过
  "stuck",        // 熔断（修订≥2 次仍 high，升级用户）
] as const;

export type ChapterState = (typeof CHAPTER_STATES)[number];

/** 合法的状态转移表（from -> allowed next states） */
export const STATE_TRANSITIONS: Record<ChapterState, readonly ChapterState[]> = {
  // 刻意不放开 imported → approved：状态机是最后一道防线，一旦允许直跳，
  // 任何一处 bug 都能把没翻过的章节标成通过，用户拿到的是一本日文。
  // 无正文章节（封面/版权页）不该靠「标记完成」蒙混，该由用户删掉。
  imported: ["ready"],
  ready: ["translating", "stuck"],
  translating: ["translated", "ready", "stuck"], // ready = 翻译失败回退重派
  translated: ["reviewing", "translating"],      // translating = 用户改译文后重译
  reviewing: ["approved", "revising", "translating", "stuck"], // stuck = 熔断升级（审校出口）
  revising: ["translated", "stuck"],             // translated = 修订完成落盘
  approved: ["translating", "reviewing"],        // 用户改术语/译文 → 需复校
  /**
   * stuck 的出口原本只有「重译」与「重置」，**没有任何一条通向 approved**。
   * 机械检查是确定性的：一个合法但被判为异常的段落，重译多少次都会再次触发，
   * 然后原路回到 stuck——用户只能一遍遍烧 token，而 46 章里只要卡住一章，
   * 整本书就永远导不出去。全书审校早有 `bookReview.decide` 的作者 override，
   * 章节级却一个都没有，等于 L4 人工确认层在这条路上是缺失的。
   * approved 只能由 `chapter.accept` 这一条显式的作者裁决触发。
   */
  stuck: ["translating", "ready", "approved"],
};

export function canTransition(from: ChapterState, to: ChapterState): boolean {
  return STATE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: ChapterState, to: ChapterState, chapterId: string): void {
  if (!canTransition(from, to)) {
    throw new Error(
      `非法状态转移: 章节 ${chapterId} 不能从 ${from} 到 ${to}（允许: ${STATE_TRANSITIONS[from]?.join(", ")}）`
    );
  }
}

export interface ChapterStatus {
  chapterId: string;
  state: ChapterState;
  /** 版本号：译文每变更一次 +1（审校按版本快照校验） */
  version: number;
  /** 修订次数（熔断判定：≥2 次仍 high → stuck） */
  reviseCount: number;
  /** 最近活动时间（heartbeat，实例级） */
  lastActivityAt: string | null;
  /** 用户修改标记（mtime 检测置位） */
  userModified: boolean;
  /** 待复校原因（用户改术语/改译文等） */
  recheckReason: string | null;
}

export function createChapterStatus(chapterId: string): ChapterStatus {
  return {
    chapterId,
    state: "imported",
    version: 0,
    reviseCount: 0,
    lastActivityAt: null,
    userModified: false,
    recheckReason: null,
  };
}

/** 推进状态：校验合法性 + 更新副作用字段。返回新状态对象（immutable）。 */
export function advanceState(
  status: ChapterStatus,
  to: ChapterState,
  options?: { userModified?: boolean; recheckReason?: string | null }
): ChapterStatus {
  assertTransition(status.state, to, status.chapterId);
  const next: ChapterStatus = { ...status, state: to };

  // 副作用规则：
  // - 进入 translating：记录活动时间
  // - 进入 translated：version + 1（新译文落盘）
  // - 进入 revising：reviseCount + 1
  // - 从 stuck/approved 重新出发：清用户修改标记
  if (to === "translating") {
    next.lastActivityAt = new Date().toISOString();
  }
  if (to === "translated") {
    next.version += 1;
  }
  if (to === "revising") {
    next.reviseCount += 1;
  }
  if (options?.userModified !== undefined) {
    next.userModified = options.userModified;
  }
  if (options?.recheckReason !== undefined) {
    next.recheckReason = options.recheckReason;
  }
  if ((fromStuckOrApproved(status.state) && to !== "reviewing") || to === "translating") {
    if (to === "translating") {
      next.userModified = false;
      next.recheckReason = null;
    }
  }
  return next;
}

function fromStuckOrApproved(state: ChapterState): boolean {
  return state === "stuck" || state === "approved";
}

/**
 * 熔断判定：修订 ≥ 1 次仍出 high 级问题（RV-03）。
 *
 * 从前是 ≥2，配套的是「局部修订 → 整章重译 → 人工」三级阶梯。整章重译退役后阶梯只剩一级，
 * ≥2 永不成立，这个判定会变成死代码。一轮修不净就交给作者——这是设计意图，不是能力不足。
 */
export function shouldEscalateToStuck(status: ChapterStatus, highIssueCount: number): boolean {
  return status.reviseCount >= 1 && highIssueCount > 0;
}
