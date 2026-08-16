import { describe, expect, it } from "vitest";
import { defaultSelection, stuckChapterIds, summarizeSelection, type ScopeChapterOption } from "./run-scope-plan";

const OPTIONS: ScopeChapterOption[] = [
  { chapterId: "ch001", title: "一", state: "approved" },
  { chapterId: "ch002", title: "二", state: "translated" },
  { chapterId: "ch003", title: "三", state: "imported" },
  { chapterId: "ch004", title: "四", state: "ready" },
  { chapterId: "ch005", title: "五", state: "stuck" },
  { chapterId: "ch006", title: "六", state: "translating" },
  { chapterId: "ch007", title: "七" },
];

describe("run-scope-plan（D4/D5/D10）", () => {
  it("默认勾选：未译章全选；已译、stuck、飞行中都不勾", () => {
    expect([...defaultSelection(OPTIONS)]).toEqual(["ch003", "ch004", "ch007"]);
  });

  it("stuck 清单是「含 stuck ×N」一键补勾的数据源", () => {
    expect(stuckChapterIds(OPTIONS)).toEqual(["ch005"]);
  });

  it("摘要行如实报数：含重译、含 stuck，且不编时长数字（D10）", () => {
    const selected = new Set(["ch001", "ch003", "ch005"]);
    const summary = summarizeSelection(OPTIONS, selected);
    expect(summary.count).toBe(3);
    expect(summary.retranslate).toBe(1);
    expect(summary.stuck).toBe(1);
    expect(summary.text).toContain("将翻译 3 章");
    expect(summary.text).toContain("含重译 1");
    expect(summary.text).toContain("含 stuck ×1");
    expect(summary.text).toContain("时长视模型思考量而定");
    // 摘要行绝不出现预估分钟数
    expect(summary.text).not.toMatch(/分钟|预计/);
  });

  it("已译章勾选 → 意图清单带 retranslate（D4 显式重译）", () => {
    const summary = summarizeSelection(OPTIONS, new Set(["ch001", "ch003"]));
    expect(summary.chapters).toEqual([
      { chapterId: "ch001", retranslate: true },
      { chapterId: "ch003" },
    ]);
  });

  it("飞行中的章即使被勾也不进清单——报进「将翻译 N 章」就是谎报范围", () => {
    const summary = summarizeSelection(OPTIONS, new Set(["ch003", "ch006"]));
    expect(summary.count).toBe(1);
    expect(summary.chapters).toEqual([{ chapterId: "ch003" }]);
  });

  it("空选择给引导语而不是一份空清单摘要", () => {
    const summary = summarizeSelection(OPTIONS, new Set());
    expect(summary.count).toBe(0);
    expect(summary.text).toContain("勾选");
  });

  it("清单保持章节树顺序，与勾选顺序无关", () => {
    const summary = summarizeSelection(OPTIONS, new Set(["ch007", "ch003"]));
    expect(summary.chapters.map((c) => c.chapterId)).toEqual(["ch003", "ch007"]);
  });
});
