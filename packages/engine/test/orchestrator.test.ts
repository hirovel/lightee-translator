import { describe, expect, it } from "vitest";
import { runPipeline } from "../src/orchestrator.js";

/** 假 Translator：默认全部成功 */
function fakeTranslator(opts?: { failChapters?: string[] }) {
  return async (chapterId: string) => {
    if (opts?.failChapters?.includes(chapterId)) throw new Error("LLM 调用失败");
    return { translation: `译文${chapterId}`, drifts: [], pendingTerms: [] };
  };
}

/** 假 Reviewer：第一次返回配置问题，后续调用返回空（模拟复校通过） */
function fakeReviewer(config?: Record<string, Array<{ severity: string; action: string; dialogueSafe?: boolean }>>) {
  let call = 0;
  return async (chapterIds: string[]) => {
    call++;
    if (call > 1) return { issues: [] }; // 复校通过
    const issues = [];
    for (const id of chapterIds) {
      for (const c of config?.[id] ?? []) {
        issues.push({
          id: `${id}_${call}_${issues.length}`,
          severity: c.severity,
          type: "term_missing",
          chapterId: id,
          expected: "X",
          found: "Y",
          dialogueSafe: c.dialogueSafe ?? true,
          suggestedAction: c.action,
        });
      }
    }
    return { issues };
  };
}

describe("Orchestrator 主循环", () => {
  it("干净流水线：全部章节 approved", async () => {
    const result = await runPipeline({
      chapterIds: ["ch001", "ch002"],
      translate: fakeTranslator(),
      review: fakeReviewer(),
    });
    expect(result.approved).toEqual(["ch001", "ch002"]);
    expect(result.allDone).toBe(true);
    expect(result.stuck).toHaveLength(0);
  });

  // EX-07 / ADR-0007：原断言是「术语未确认时停等在 ready（不翻译）」。
  // 译前提取阶段退役后不存在「未确认」这个状态了——术语随翻译逐章长出来（EX-04），
  // 门禁留着就是拿一个不再运行的阶段挡住核心能力。改为正向断言：**导入即可翻**。
  it("没有术语表也照翻（EX-07 导入即可翻）", async () => {
    let translated = 0;
    const result = await runPipeline({
      chapterIds: ["ch001"],
      translate: async () => { translated++; return { translation: "x", drifts: [], pendingTerms: [] }; },
      review: fakeReviewer(),
    });
    expect(translated).toBe(1);
    expect(result.outcomes[0]!.state).toBe("approved");
  });

  // RV-03：suggestedAction 为 replace_all 的术语问题不再触发字符串盲替换，
  // 与 revise_chapter 走同一条路——局部修订。两者的区别只剩「修订指示怎么写」。
  it("术语问题经局部修订后复校通过 → approved（不发生字符串替换）", async () => {
    const result = await runPipeline({
      chapterIds: ["ch001"],
      translate: fakeTranslator(),
      review: fakeReviewer({ ch001: [{ severity: "high", action: "replace_all" }] }),
      resolveIssueParagraphs: () => ["p0002"],
      totalParagraphs: () => 20,
      revisePassages: async (_id, items) => items.map((it) => ({ paragraphId: it.paragraphId, translation: `修订${it.paragraphId}` })),
      applyParagraphChanges: () => {},
    });
    expect(result.approved).toContain("ch001");
    expect(result.outcomes[0]!.reviseCount).toBeGreaterThanOrEqual(1);
  });

  it("局部修订一轮后复校通过 → approved，且没有整章重译", async () => {
    let translateCalls = 0;
    const result = await runPipeline({
      chapterIds: ["ch001"],
      translate: async () => { translateCalls++; return { translation: "x", drifts: [], pendingTerms: [] }; },
      review: fakeReviewer({ ch001: [{ severity: "high", action: "revise_chapter" }] }),
      resolveIssueParagraphs: () => ["p0002"],
      totalParagraphs: () => 20,
      revisePassages: async (_id, items) => items.map((it) => ({ paragraphId: it.paragraphId, translation: `修订${it.paragraphId}` })),
      applyParagraphChanges: () => {},
    });
    expect(result.approved).toContain("ch001");
    expect(translateCalls).toBe(1); // 只有初译
  });

  it("熔断：复校仍 high → stuck", async () => {
    // 持续返回 high（不通过）的 reviewer
    const alwaysHigh = async (chapterIds: string[]) => ({
      issues: chapterIds.map((id) => ({
        id: `${id}_high`,
        severity: "high" as const,
        type: "term_missing",
        chapterId: id,
        expected: "X",
        found: "Y",
        dialogueSafe: true,
        suggestedAction: "revise_chapter" as const,
      })),
    });
    const result = await runPipeline({
      chapterIds: ["ch001"],
      translate: fakeTranslator(),
      review: alwaysHigh,
    });
    expect(result.stuck).toContain("ch001");
    expect(result.allDone).toBe(false);
  });

  it("翻译失败 → 回退 ready（可重试）", async () => {
    const result = await runPipeline({
      chapterIds: ["ch001", "ch002"],
      translate: fakeTranslator({ failChapters: ["ch002"] }),
      review: fakeReviewer(),
    });
    expect(result.approved).toContain("ch001");
    const ch2 = result.outcomes.find((o) => o.chapterId === "ch002")!;
    expect(ch2.state).toBe("ready"); // 失败回退，等待重试
    expect(ch2.lastError).toContain("LLM 调用失败");
  });

  it("恢复 persisted translating 时为实际 translator execution 增加 attempt", async () => {
    let translateCalls = 0;
    const result = await runPipeline({
      chapterIds: ["ch001"],
      translate: async () => {
        translateCalls++;
        return { translation: "恢复译文", drifts: [], pendingTerms: [] };
      },
      review: async () => ({ issues: [] }),
      initialStates: new Map([["ch001", {
        chapterId: "ch001",
        state: "translating",
        version: 0,
        reviseCount: 0,
        lastActivityAt: null,
        userModified: false,
        recheckReason: null,
        attempt: 1,
        retryCount: 0,
        lastError: null,
        lastReason: "interrupted",
        runId: "old-run",
        transitionCount: 2,
      }]]) as never,
    });
    expect(translateCalls).toBe(1);
    expect(result.outcomes[0]).toMatchObject({ state: "approved", attempt: 2 });
  });

  it("断点续跑：initialStates 保留已 approved 章节", async () => {
    // 模拟 ch001 已 approved（上次运行完成），ch002 新加
    const result = await runPipeline({
      chapterIds: ["ch001", "ch002"],
      translate: fakeTranslator(),
      review: fakeReviewer(),
      initialStates: new Map([["ch001", { chapterId: "ch001", state: "approved", version: 1, reviseCount: 0, lastActivityAt: null, userModified: false, recheckReason: null }]]),
    });
    expect(result.approved).toContain("ch001");
    expect(result.approved).toContain("ch002");
  });

  it("并发翻译：多章节都完成", async () => {
    let active = 0;
    let maxActive = 0;
    const result = await runPipeline({
      chapterIds: ["ch001", "ch002", "ch003", "ch004", "ch005"],
      concurrency: 3,
      translate: async (id) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return { translation: `译文${id}`, drifts: [], pendingTerms: [] };
      },
      review: fakeReviewer(),
    });
    expect(maxActive).toBeLessThanOrEqual(3); // 并发上限
    expect(result.approved).toHaveLength(5);
  });
});
