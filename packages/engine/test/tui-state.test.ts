import { describe, expect, it } from "vitest";
import {
  createTuiState,
  moveSelection,
  setView,
  stats,
  translateChapter,
  type ChapterStatusUI,
} from "../src/tui-state.js";

describe("TUI 状态逻辑", () => {
  it("初始状态：第一个章节选中，列表视图", () => {
    const s = createTuiState([
      { id: "ch001", title: "第1章", state: "imported" },
      { id: "ch002", title: "第2章", state: "imported" },
    ]);
    expect(s.selectedIndex).toBe(0);
    expect(s.view).toBe("list");
    expect(s.chapters).toHaveLength(2);
  });

  it("移动选择（边界不越界）", () => {
    const s = createTuiState([
      { id: "ch001", title: "第1章", state: "imported" },
      { id: "ch002", title: "第2章", state: "imported" },
    ]);
    const down = moveSelection(s, "down");
    expect(down.selectedIndex).toBe(1);
    // 继续向下 → 回到 0（循环）
    const down2 = moveSelection(down, "down");
    expect(down2.selectedIndex).toBe(0);
    // 从 0 向上 → 到末尾（循环）
    const up = moveSelection(s, "up");
    expect(up.selectedIndex).toBe(1);
  });

  it("切换视图（list/detail）", () => {
    const s = createTuiState([{ id: "ch001", title: "第1章", state: "imported" }]);
    expect(setView(s, "detail").view).toBe("detail");
    expect(setView(s, "list").view).toBe("list");
  });

  it("翻译本章更新状态为 translating → translated", async () => {
    let s = createTuiState([
      { id: "ch001", title: "第1章", state: "ready" },
      { id: "ch002", title: "第2章", state: "ready" },
    ]);
    s = await translateChapter(s, {
      translate: async () => ({ translation: "译文", drifts: [], pendingTerms: [] }),
    });
    expect(s.chapters[0]!.state).toBe("translated");
    expect(s.log.length).toBeGreaterThan(0);
  });

  it("翻译失败记录错误，状态回退 ready", async () => {
    let s = createTuiState([{ id: "ch001", title: "第1章", state: "ready" }]);
    s = await translateChapter(s, {
      translate: async () => { throw new Error("LLM 挂了"); },
    });
    expect(s.chapters[0]!.state).toBe("ready");
    expect(s.log.some((l) => l.includes("LLM 挂了"))).toBe(true);
  });

  it("进度统计", () => {
    const s = createTuiState([
      { id: "ch001", title: "a", state: "approved" },
      { id: "ch002", title: "b", state: "translating" },
      { id: "ch003", title: "c", state: "imported" },
    ]);
    const st = stats(s);
    expect(st.approved).toBe(1);
    expect(st.total).toBe(3);
    expect(st.percent).toBe(33);
  });
});
