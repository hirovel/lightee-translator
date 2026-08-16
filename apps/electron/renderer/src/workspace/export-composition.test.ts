import { describe, expect, it } from "vitest";
import {
  acceptableChapters,
  composeExport,
  describeComposition,
  describeExportResult,
  exportBlockReason,
} from "./export-composition.js";

const chapters = [
  { id: "ch001", title: "第一章", state: "approved" as const },
  { id: "ch002", title: "第二章", state: "stuck" as const },
  { id: "ch003", title: "第三章", state: "translated" as const },
  { id: "ch004", title: "第四章", state: "imported" as const },
  { id: "ch005", title: "第五章", state: "translating" as const },
];

describe("composeExport", () => {
  it("按状态分三堆：已完成 / 有译文未完成 / 尚无译文", () => {
    const summary = composeExport(chapters);
    expect(summary.done.map((c) => c.id)).toEqual(["ch001"]);
    expect(summary.draft.map((c) => c.id)).toEqual(["ch002", "ch003"]);
    expect(summary.missing.map((c) => c.id)).toEqual(["ch004", "ch005"]);
  });

  it("translating 算「尚无译文」——正在翻不等于已经有译文", () => {
    expect(composeExport([{ id: "a", title: "A", state: "translating" }]).missing).toHaveLength(1);
  });

  it("state 缺失时按尚无译文算，不假设它有", () => {
    expect(composeExport([{ id: "a", title: "A" }]).missing.map((c) => c.id)).toEqual(["a"]);
  });
});

describe("describeComposition", () => {
  it("三段都非零时逐段说清楚", () => {
    expect(describeComposition(composeExport(chapters))).toBe("1 章已完成 · 2 章有译文未完成 · 2 章尚无译文");
  });

  it("为零的那一段不出现——「0 章尚无译文」是噪音", () => {
    const summary = composeExport([{ id: "a", title: "A", state: "approved" }]);
    expect(describeComposition(summary)).toBe("1 章已完成");
  });

  it("一章都没有时说空工作区，而不是拼出一串 0", () => {
    expect(describeComposition(composeExport([]))).toBe("这个工作区还没有章节");
  });
});

describe("exportBlockReason", () => {
  it("全书：只要有一章有译文就能导——approved 与全书审校都不再是条件", () => {
    expect(exportBlockReason("book", composeExport(chapters), undefined)).toBeUndefined();
  });

  it("全书：一章译文都没有时才挡，理由是真的没有东西可导", () => {
    const empty = composeExport([{ id: "a", title: "A", state: "imported" }]);
    expect(exportBlockReason("book", empty, undefined)).toBe("这本书还没有任何译文");
  });

  it("单章：没打开章节时说打开章节，不说别的", () => {
    expect(exportBlockReason("current", composeExport(chapters), undefined)).toBe("请先打开要导出的章节");
  });

  it("单章：打开的章节尚无译文时挡，理由指向这一章", () => {
    expect(exportBlockReason("current", composeExport(chapters), chapters[3])).toBe("这一章还没有译文");
  });

  it("单章：有译文未定稿也放行——后端读暂存稿", () => {
    expect(exportBlockReason("current", composeExport(chapters), chapters[2])).toBeUndefined();
  });

  it("挑选章节：一章没勾时说的是「还没说要导什么」，不是「导不出」", () => {
    expect(exportBlockReason("pick", composeExport(chapters), undefined, [])).toBe("先勾选要导出的章节");
  });

  it("挑选章节：勾的全是没译的才挡；混着一章有译文就放行（其余会被跳过并如实报出）", () => {
    const summary = composeExport(chapters);
    expect(exportBlockReason("pick", summary, undefined, ["ch004", "ch005"])).toBe("勾选的章节都还没有译文");
    expect(exportBlockReason("pick", summary, undefined, ["ch004", "ch003"])).toBeUndefined();
  });
});

describe("acceptableChapters", () => {
  it("只有 stuck 能批量标记完成；其余状态不在名单里", () => {
    expect(acceptableChapters(chapters).map((c) => c.id)).toEqual(["ch002"]);
  });
});

describe("describeExportResult", () => {
  it("跳过的章节逐个报出来，作者才知道成品少了什么", () => {
    const line = describeExportResult({ exported: ["ch001", "ch003"], fromStaging: ["ch003"], skipped: ["ch004"] }, chapters);
    expect(line).toContain("2 章");
    expect(line).toContain("其中 1 章来自暂存稿");
    expect(line).toContain("第四章");
  });

  it("没有跳过也没有暂存稿时只说导了几章", () => {
    expect(describeExportResult({ exported: ["ch001"], fromStaging: [], skipped: [] }, chapters)).toBe("已导出 1 章");
  });

  it("后端没回名单时不编造构成", () => {
    expect(describeExportResult({}, chapters)).toBe("已导出");
  });
});
