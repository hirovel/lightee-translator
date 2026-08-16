import { describe, expect, it } from "vitest";
import { runPipeline, type PipelineOptions } from "./orchestrator.ts";

type Issue = Awaited<ReturnType<NonNullable<PipelineOptions["review"]>>>["issues"][number];

function highIssue(chapterId: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id: `${chapterId}_high`,
    severity: "high",
    type: "term_missing",
    chapterId,
    expected: "X",
    found: "Y",
    dialogueSafe: true,
    ...overrides,
  };
}

describe("PL-06 未决章节不得滞留 translated", () => {
  it("修不掉的章节一律进 stuck 清单，approved/stuck 两侧都要报得出来", async () => {
    // RV-03 之后修复阶梯只剩一级（局部修订 1 轮 → request_human），
    // 「4 轮耗尽」在实际路径上已不可达；PL-06 的最终清扫留作防御性兜底。
    // 这里守的是它真正保护的不变量：没有章节静默停在 translated。
    const result = await runPipeline({
      chapterIds: ["ch001", "ch002"],
      translate: async (id) => ({ translation: `译文${id}`, drifts: [], pendingTerms: [] }),
      review: async (ids) => ({ issues: ids.map((id) => highIssue(id)) }),
    });

    expect(result.outcomes.filter((o) => o.state === "translated")).toHaveLength(0);
    expect(result.stuck).toEqual(["ch001", "ch002"]);
    expect(result.allDone).toBe(false);
  });
});

describe("修订动作由代码选定（PL-12 / MG-01）", () => {
  it("选中动作等于 allowed 首项：可定位少量段落时走局部修订而不是交人", async () => {
    let revisePassagesCalls = 0;
    const result = await runPipeline({
      chapterIds: ["ch001"],
      translate: async (id) => ({ translation: `译文${id}`, drifts: [], pendingTerms: [] }),
      review: (() => {
        let call = 0;
        return async (ids: string[]) => {
          call += 1;
          return { issues: call === 1 ? ids.map((id) => highIssue(id)) : [] };
        };
      })(),
      // 可定位 1 段 / 共 20 段 → allowed 首项为 revise_passages
      resolveIssueParagraphs: () => ["p0002"],
      totalParagraphs: () => 20,
      revisePassages: async (_id, items) => {
        revisePassagesCalls += 1;
        return items.map((it) => ({ paragraphId: it.paragraphId, translation: `修订${it.paragraphId}` }));
      },
      applyParagraphChanges: () => {},
    });

    expect(revisePassagesCalls).toBe(1);
    expect(result.approved).toEqual(["ch001"]);
  });
});

describe("PL-31 修复阶段并发", () => {
  it("修复并发生效且结果与串行一致", async () => {
    // RV-03 后修复动作是局部修订（整章重译已退役），并发保证的载体随之更换，
    // 但保证本身不变：修复走与翻译同一并发池，按 id 分发保证同章排他。
    let active = 0;
    let maxRepairActive = 0;
    let reviewCall = 0;
    const chapterIds = ["ch001", "ch002", "ch003", "ch004", "ch005"];
    const result = await runPipeline({
      chapterIds,
      concurrency: 3,
      translate: async (id) => ({ translation: `译文${id}`, drifts: [], pendingTerms: [] }),
      review: async (ids) => {
        reviewCall += 1;
        return { issues: reviewCall === 1 ? ids.map((id) => highIssue(id)) : [] };
      },
      resolveIssueParagraphs: () => ["p0002"],
      totalParagraphs: () => 20,
      revisePassages: async (_id, items) => {
        active += 1;
        maxRepairActive = Math.max(maxRepairActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active -= 1;
        return items.map((it) => ({ paragraphId: it.paragraphId, translation: `修订${it.paragraphId}` }));
      },
      applyParagraphChanges: () => {},
    });

    expect(maxRepairActive).toBeGreaterThan(1);
    expect(maxRepairActive).toBeLessThanOrEqual(3);
    expect(result.approved).toEqual(chapterIds);
    expect(result.allDone).toBe(true);
  });
});
