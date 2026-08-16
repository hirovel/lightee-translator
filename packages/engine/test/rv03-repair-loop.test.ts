/**
 * RV-03 修订循环重构：盲替换与整章重译退役。
 *
 * 定调（用户）：作者自己核对是主流程，机器修复只允许**精确、局部、带明确指示**的那种。
 * - `replace_all` 的字符串盲替换不看上下文，把「雏鸟」换成「小灯」会造语法/量词错配；
 * - 整章重译花 token 把整章重写去修一个局部问题，还可能把别处改坏；
 * - 修不净就交给作者，而不是再烧一轮。
 */
import { describe, expect, it } from "vitest";
import { runPipeline, type PipelineOptions } from "../src/orchestrator.js";

type Issue = {
  id: string;
  severity: "high" | "medium";
  type: string;
  chapterId: string;
  expected?: string;
  found?: string;
  termJa?: string;
  dialogueSafe: boolean;
  location?: string;
  paragraphIds?: string[];
};

function reviewWith(plan: Array<Issue[]>): NonNullable<PipelineOptions["review"]> {
  let call = 0;
  return async () => {
    const issues = plan[Math.min(call, plan.length - 1)] ?? [];
    call++;
    return { issues: issues.map((i) => ({ ...i })) };
  };
}

function baseOptions(overrides: Partial<PipelineOptions> = {}): PipelineOptions {
  return {
    chapterIds: ["ch001"],
    translate: async (chapterId: string) => ({ translation: `译文${chapterId}`, drifts: [], pendingTerms: [] }),
    review: reviewWith([[]]),
    ...overrides,
  };
}

/**
 * 禁翻词被译掉。`no_translate_missing` 是术语检查整族删除之后**仅存的 high 级
 * 术语类问题**，所以修复循环的用例一律用它当夹具。
 *
 * 形状照 reviewer-scan 的真实产出写（termJa = expected = 原词、没有 found、
 * dialogueSafe=false）：假一个运行时从不产出的形状，测试面就比生产面松，等于没测。
 */
const TERM_DRIFT: Issue = {
  id: "i1", severity: "high", type: "no_translate_missing", chapterId: "ch001",
  expected: "Wi-Fi", termJa: "Wi-Fi",
  dialogueSafe: false,
  location: "ch001.md:p0002", paragraphIds: ["p0002"],
};

describe("RV-03 术语问题走局部修订，不做盲替换", () => {
  it("high 级术语问题 → revisePassages，修订指示带上作者权威声明", async () => {
    let replaced = false;
    let items: Array<{ paragraphId: string; issues: string[] }> = [];
    const result = await runPipeline(baseOptions({
      review: reviewWith([[{ ...TERM_DRIFT }], []]),
      resolveIssueParagraphs: (issue) => (issue as Issue).paragraphIds ?? [],
      totalParagraphs: () => 20,
      applyReplacement: async () => { replaced = true; },
      revisePassages: async (_id, got) => {
        items = got;
        return got.map((it) => ({ paragraphId: it.paragraphId, translation: `修订${it.paragraphId}` }));
      },
      applyParagraphChanges: async () => {},
    }));

    expect(replaced).toBe(false);
    expect(items).toHaveLength(1);
    const instruction = items[0]!.issues.join("\n");
    expect(instruction).toContain("Wi-Fi");
    expect(instruction).toContain("原样保留");
    expect(instruction).toContain("作者");
    expect(result.approved).toContain("ch001");
  });

  /**
   * 回归：`pun_note_missing` 的 `found` 是一句**说明文字**（「译法有但译注缺失」）。
   * 从前 reviseInstructionFor 是一句通用拼装 `found ? 把「found」改为「expected」 : …`，
   * 于是它会写出「把「译法有但译注缺失」改为「小灯」」——指使模型去替换一句描述。
   * 低 severity 的问题同样会被写进同段的修订指示，所以它确实到得了这里。
   */
  it("谐音梗缺译注的指示是「译作 X 并加译注」，不是「把那句描述换成 X」", async () => {
    let items: Array<{ paragraphId: string; issues: string[] }> = [];
    await runPipeline(baseOptions({
      review: reviewWith([[{ ...TERM_DRIFT }, {
        ...TERM_DRIFT, id: "i2", severity: "medium", type: "pun_note_missing",
        found: "译法有但译注缺失", expected: "小灯", termJa: "灯ヒナ", dialogueSafe: true,
      }], []]),
      resolveIssueParagraphs: (issue) => (issue as Issue).paragraphIds ?? [],
      totalParagraphs: () => 20,
      revisePassages: async (_id, got) => {
        items = got;
        return got.map((it) => ({ paragraphId: it.paragraphId, translation: `修订${it.paragraphId}` }));
      },
      applyParagraphChanges: async () => {},
    }));
    const instruction = items[0]!.issues.join("\n");
    expect(instruction).toContain("灯ヒナ");
    expect(instruction).toContain("小灯");
    expect(instruction).toContain("译注");
    expect(instruction).not.toContain("译法有但译注缺失");
  });
});

describe("RV-03 整章重译退役，一轮修不净就交给作者", () => {
  it("局部修订一轮后仍有 high → stuck，且全程只翻译过一次", async () => {
    let translateCalls = 0;
    let reviseCalls = 0;
    const result = await runPipeline(baseOptions({
      translate: async () => { translateCalls++; return { translation: "x", drifts: [], pendingTerms: [] }; },
      review: reviewWith([[{ ...TERM_DRIFT }], [{ ...TERM_DRIFT }], [{ ...TERM_DRIFT }]]),
      resolveIssueParagraphs: (issue) => (issue as Issue).paragraphIds ?? [],
      totalParagraphs: () => 20,
      revisePassages: async (_id, got) => { reviseCalls++; return got.map((it) => ({ paragraphId: it.paragraphId, translation: `修订${it.paragraphId}` })); },
      applyParagraphChanges: async () => {},
    }));
    expect(translateCalls).toBe(1); // 只有初译，没有整章重译
    expect(reviseCalls).toBe(1);    // 恰好一轮局部修订，不是空转到轮次耗尽
    expect(result.stuck).toContain("ch001");
    expect(result.approved).toHaveLength(0);
  });

  it("定位不到段落 → 直接交给作者，不再整章重译碰运气", async () => {
    let translateCalls = 0;
    const result = await runPipeline(baseOptions({
      translate: async () => { translateCalls++; return { translation: "x", drifts: [], pendingTerms: [] }; },
      review: reviewWith([[{ ...TERM_DRIFT, paragraphIds: [] }], []]),
      resolveIssueParagraphs: () => [],
      revisePassages: async (_id, got) => got.map((it) => ({ paragraphId: it.paragraphId, translation: "x" })),
      applyParagraphChanges: async () => {},
    }));
    expect(translateCalls).toBe(1);
    expect(result.stuck).toContain("ch001");
  });

  it("配了备用模型也不再整章换模型重译", async () => {
    const usedModels: Array<string | undefined> = [];
    let reviseCalls = 0;
    const result = await runPipeline(baseOptions({
      translate: async (_id, opts) => { usedModels.push(opts.model); return { translation: "x", drifts: [], pendingTerms: [] }; },
      review: reviewWith([[{ ...TERM_DRIFT }], [{ ...TERM_DRIFT }], [{ ...TERM_DRIFT }]]),
      resolveIssueParagraphs: (issue) => (issue as Issue).paragraphIds ?? [],
      totalParagraphs: () => 20,
      hasFallbackModel: true,
      fallbackModel: "fallback/model",
      revisePassages: async (_id, got) => { reviseCalls++; return got.map((it) => ({ paragraphId: it.paragraphId, translation: "x" })); },
      applyParagraphChanges: async () => {},
    }));
    expect(usedModels).toEqual([undefined]);
    expect(reviseCalls).toBe(1);
    expect(result.stuck).toContain("ch001");
  });
});
