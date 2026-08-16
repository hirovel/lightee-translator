import { describe, expect, it } from "vitest";
import { runPipeline, type PipelineOptions } from "../src/orchestrator.js";

type Issue = {
  id: string;
  severity: "high" | "medium";
  type: string;
  chapterId: string;
  expected?: string;
  found?: string;
  dialogueSafe: boolean;
  suggestedAction: "replace_all" | "revise_chapter" | "review_again" | "ignore";
  location?: string;
};

function fakeTranslator() {
  return async (chapterId: string) => ({ translation: `译文${chapterId}`, drifts: [], pendingTerms: [] });
}

function reviewWith(plan: Array<Issue[]>): NonNullable<PipelineOptions["review"]> {
  let call = 0;
  return async (chapterIds: string[]) => {
    const issues = plan[Math.min(call, plan.length - 1)] ?? [];
    call++;
    return { issues: issues.map((i) => ({ ...i })) };
  };
}

function baseOptions(overrides: Partial<PipelineOptions> = {}): PipelineOptions {
  return {
    chapterIds: ["ch001"],
    translate: fakeTranslator(),
    review: reviewWith([[]]),
    ...overrides,
  };
}

const HIGH: Issue = { id: "i1", severity: "high", type: "term_missing", chapterId: "ch001", expected: "X", found: "Y", dialogueSafe: true, suggestedAction: "revise_chapter", location: "ch001_zh.md:2" };

describe("BQ-03 Manager 修订闭环", () => {
  it("局部修订：可定位 ≤5 段 → revise_passages 应用 patch → 复校通过", async () => {
    let reviseItems: Array<{ paragraphId: string; issues: string[] }> | null = null;
    let applied: Array<{ paragraphId: string; translation: string }> = [];
    const result = await runPipeline(baseOptions({
      review: reviewWith([
        [{ ...HIGH }],
        [],
      ]),
      resolveIssueParagraphs: () => ["p0002", "p0003"],
      totalParagraphs: () => 20,
      revisePassages: async (id, items) => {
        reviseItems = items;
        return items.map((it) => ({ paragraphId: it.paragraphId, translation: `修订${it.paragraphId}` }));
      },
      applyParagraphChanges: async (_id, changes) => { applied = changes; },
      manager: {
        decide: async (_t, payload) => {
          expect((payload.allowedActions as string[])).toContain("revise_passages");
          return { action: "revise_passages", chapterId: "ch001", paragraphIds: ["p0002", "p0003"] };
        },
      },
    }));
    expect(reviseItems).not.toBeNull();
    expect(reviseItems![0]!.paragraphId).toBe("p0002");
    expect(applied).toHaveLength(2);
    expect(result.approved).toContain("ch001");
  });

  it("不可定位（无 resolveIssueParagraphs）→ 无 revise_passages，直接交给作者", async () => {
    // RV-03：从前这里回退整章重译。现在定位不到就是定位不到，交给作者比碰运气重写整章诚实。
    let translateCalls = 0;
    const result = await runPipeline(baseOptions({
      translate: async () => { translateCalls++; return { translation: "x", drifts: [], pendingTerms: [] }; },
      review: reviewWith([
        [{ ...HIGH }],
        [],
      ]),
    }));
    expect(translateCalls).toBe(1); // 只有初译
    expect(result.stuck).toContain("ch001");
  });

  it("Manager 选 keep 但存在未解决 high → 被拒绝（keep 不在 allowedActions）", async () => {
    let translateCalls = 0;
    const result = await runPipeline(baseOptions({
      translate: async () => { translateCalls++; return { translation: "x", drifts: [], pendingTerms: [] }; },
      review: reviewWith([
        [{ ...HIGH }],
        [],
      ]),
      manager: {
        decide: async (type, payload) => {
          if (type === "arbitrate") {
            expect((payload.allowedActions as string[])).not.toContain("keep");
            return { action: "keep" }; // 非法选择 → 应被代码拒绝
          }
          return { action: "keep" };
        },
      },
    }));
    // keep 被拒后的确定性回退，RV-03 之后是「交给作者」而不是整章重译
    expect(translateCalls).toBe(1);
    expect(result.stuck).toContain("ch001");
    expect(result.approved).not.toContain("ch001");
  });

  it("Manager 返回 allowedActions 之外的动作 → 拒绝并安全回退", async () => {
    const result = await runPipeline(baseOptions({
      review: reviewWith([
        [{ ...HIGH }],
        [],
      ]),
      manager: {
        decide: async () => ({ action: "skip", note: "越权" }),
      },
    }));
    expect(result.stuck).toContain("ch001"); // skip 不在 allowed → 回退到 request_human
  });

  it("重复同类缺陷 → 局部不再允许 → request_human（stuck）", async () => {
    let translateCalls = 0;
    const result = await runPipeline(baseOptions({
      translate: async () => { translateCalls++; return { translation: "x", drifts: [], pendingTerms: [] }; },
      // 每轮都返回同一 high（无进展）
      review: reviewWith([
        [{ ...HIGH, id: "i1" }],
        [{ ...HIGH, id: "i1" }],
        [{ ...HIGH, id: "i1" }],
      ]),
      resolveIssueParagraphs: () => ["p0002"],
      totalParagraphs: () => 20,
      revisePassages: async (_id, items) => items.map((it) => ({ paragraphId: it.paragraphId, translation: `修订${it.paragraphId}` })),
      applyParagraphChanges: async () => {},
    }));
    expect(translateCalls).toBe(1); // RV-03：中间不再插一轮整章重译
    expect(result.stuck).toContain("ch001");
    expect(result.approved).toHaveLength(0);
  });

  it("keep：无 high 时允许并 approved", async () => {
    const result = await runPipeline(baseOptions({
      review: reviewWith([
        [{ id: "m1", severity: "medium", type: "style", chapterId: "ch001", dialogueSafe: true, suggestedAction: "review_again", location: "ch001_zh.md:3" }],
      ]),
      manager: {
        decide: async (type, payload) => {
          if (type === "arbitrate") {
            expect((payload.allowedActions as string[])).toContain("keep");
            return { action: "keep", note: "medium 可接受" };
          }
          return { action: "keep" };
        },
      },
    }));
    expect(result.approved).toContain("ch001");
  });
});
