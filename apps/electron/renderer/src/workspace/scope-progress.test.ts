import { describe, expect, it } from "vitest";
import { busyScopePrefix, reduceScopeEvent, stopButtonView, type ScopeRunView } from "./scope-progress";

const started = { runId: "scope_a", phase: "started" as const, total: 3 };

function run(events: Parameters<typeof reduceScopeEvent>[1][]): ScopeRunView | null {
  return events.reduce<ScopeRunView | null>((view, event) => reduceScopeEvent(view, event), null);
}

describe("scope-progress（RS-2 忙碌卡 k/N 与两段停止视图）", () => {
  it("started → chapter-started 推进 k/N；finished 收摊", () => {
    const mid = run([started, { runId: "scope_a", phase: "chapter-started", total: 3, index: 2, chapterId: "ch002" }]);
    expect(mid).toMatchObject({ index: 2, total: 3, chapterId: "ch002", stop: "none" });
    expect(busyScopePrefix(mid)).toBe("第 2/3 章 · ");
    expect(run([started, { runId: "scope_a", phase: "finished", total: 3 }])).toBeNull();
  });

  it("单章跑批不加 k/N 前缀——「第 1/1 章」是废话", () => {
    const view = run([
      { runId: "scope_b", phase: "started", total: 1 },
      { runId: "scope_b", phase: "chapter-started", total: 1, index: 1, chapterId: "ch001" },
    ]);
    expect(busyScopePrefix(view)).toBe("");
  });

  it("中途接入：chapter-started 足以重建视图（切工作区回来时不丢 k/N）", () => {
    const view = run([{ runId: "scope_mid", phase: "chapter-started", total: 9, index: 7, chapterId: "ch007" }]);
    expect(view).toMatchObject({ runId: "scope_mid", total: 9, index: 7, chapterId: "ch007", stop: "none" });
    // 信息不全的孤儿相位不凭空造视图——半截状态比没有更坏
    expect(run([{ runId: "scope_x", phase: "chapter-done", total: 2, index: 1 }])).toBeNull();
    expect(run([{ runId: "scope_x", phase: "stop-requested", total: 2, stop: "boundary" }])).toBeNull();
  });

  it("停止按钮三档（D7）：停止 → 翻完本章即停 → 正在取消", () => {
    const running = run([started, { runId: "scope_a", phase: "chapter-started", total: 3, index: 1, chapterId: "ch001" }]);
    expect(stopButtonView(running)).toMatchObject({ label: "⏹ 停止", disabled: false });
    const boundary = reduceScopeEvent(running, { runId: "scope_a", phase: "stop-requested", total: 3, stop: "boundary" });
    expect(stopButtonView(boundary).label).toContain("翻完本章即停");
    const cancelled = reduceScopeEvent(boundary, { runId: "scope_a", phase: "stop-requested", total: 3, stop: "cancelled" });
    expect(stopButtonView(cancelled)).toMatchObject({ label: "正在取消…", disabled: true });
  });
});
