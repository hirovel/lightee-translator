/**
 * 跑批进度状态机（RS-2）。`translate.scopeChanged` 事件流 → 忙碌卡 k/N 前缀
 * 与停止按钮的档位视图。纯函数，DOM 由 workspace-bridge 画。
 */

export interface ScopeChangedPayload {
  runId: string;
  phase: "started" | "chapter-started" | "chapter-skipped" | "chapter-done" | "stop-requested" | "finished" | "notification-clicked";
  total: number;
  index?: number;
  chapterId?: string;
  reason?: string;
  stop?: "none" | "boundary" | "cancelled";
}

export interface ScopeRunView {
  runId: string;
  total: number;
  /** 当前（或最近开工的）章序号，1-based；started 后、首章开工前为 0 */
  index: number;
  chapterId: string | null;
  stop: "none" | "boundary" | "cancelled";
}

/** 事件 → 新视图。finished 返回 null（跑批结束，视图收摊）。乱序旧 run 的事件忽略 */
export function reduceScopeEvent(current: ScopeRunView | null, payload: ScopeChangedPayload): ScopeRunView | null {
  if (payload.phase === "notification-clicked") return current;
  if (payload.phase === "started") {
    return { runId: payload.runId, total: payload.total, index: 0, chapterId: null, stop: "none" };
  }
  if (!current || current.runId !== payload.runId) {
    // 中途接入（切工作区回来）：chapter-started 携带 runId/total/index，足以重建视图。
    // 其余相位信息不全，重建出来只会是半截状态——比没有更坏，忽略。
    if (payload.phase === "chapter-started") {
      return { runId: payload.runId, total: payload.total, index: payload.index ?? 0, chapterId: payload.chapterId ?? null, stop: "none" };
    }
    return current;
  }
  if (payload.phase === "finished") return null;
  if (payload.phase === "chapter-started") {
    return { ...current, index: payload.index ?? current.index, chapterId: payload.chapterId ?? null };
  }
  if (payload.phase === "stop-requested") {
    return { ...current, stop: payload.stop ?? current.stop };
  }
  // chapter-skipped / chapter-done：序号推进由下一次 chapter-started 负责
  return current;
}

/** 忙碌卡次行的 k/N 前缀（单章跑批不加——「第 1/1 章」是废话） */
export function busyScopePrefix(view: ScopeRunView | null): string {
  if (!view || view.total <= 1 || view.index <= 0) return "";
  return `第 ${view.index}/${view.total} 章 · `;
}

/** 停止按钮视图（D7 两段式） */
export function stopButtonView(view: ScopeRunView | null): { label: string; title: string; disabled: boolean } {
  if (!view) return { label: "", title: "", disabled: true };
  if (view.stop === "none") return { label: "⏹ 停止", title: "第一次点击：翻完当前章即停（落盘完整）", disabled: false };
  if (view.stop === "boundary") return { label: "翻完本章即停 · 再点立即取消", title: "再次点击：立即取消当前章（状态回到待翻译）", disabled: false };
  return { label: "正在取消…", title: "已请求立即取消", disabled: true };
}
