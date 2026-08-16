import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { createWorkspace, type Workspace } from "../src/workspace.ts";
import { shardChapters, runBookReview } from "../src/book-review.ts";
import { writeChapterParagraphs } from "../src/paragraph-gate.ts";

let dir: string;
let ws: Workspace;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lightee-bookrev-"));
  ws = await createWorkspace(dir, { name: "全文审校" });
  await mkdir(join(dir, "source"), { recursive: true });
  await mkdir(join(dir, "terminology"), { recursive: true });
  await writeFile(
    join(dir, "source", "manifest.json"),
    JSON.stringify({ book: "测试书", chapters: [
      { id: "ch001", title: "一" },
      { id: "ch002", title: "二" },
      { id: "ch003", title: "三" },
    ] })
  );
  await writeFile(join(dir, "terminology", "names.json"), JSON.stringify([{ ja: "アリス", zh: "爱丽丝", type: "name" }]));
  await writeChapterParagraphs(ws, "ch001", [
    { id: "p0001", type: "body", source: "アリスが来た。", translation: "爱丽丝来了。" },
  ], { staging: true });
  await writeChapterParagraphs(ws, "ch002", [
    { id: "p0001", type: "body", source: "アリスが笑う。", translation: "爱丽丝笑了。" },
  ], { staging: true });
  await writeChapterParagraphs(ws, "ch003", [
    { id: "p0001", type: "body", source: "アリスが帰る。", translation: "爱丽丝走了。" },
  ], { staging: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("shardChapters", () => {
  const chapters = Array.from({ length: 10 }, (_, i) => ({
    id: `ch${String(i + 1).padStart(3, "0")}`,
    source: "x".repeat(500),
    translation: "y".repeat(500),
  }));

  it("小上下文 → 多 shard + 边界重叠", () => {
    const shards = shardChapters(chapters, 4096, 0.4); // 目标 ~1638 token ≈ 每章 1000 → 每 shard 1-2 章
    expect(shards.length).toBeGreaterThan(1);
    // 除首个外都有重叠（前一 shard 末尾 1 章）
    for (let i = 1; i < shards.length; i++) {
      const prev = shards[i - 1]!.base;
      expect(shards[i]!.overlap).toEqual([prev[prev.length - 1]!.id]);
    }
  });

  it("大上下文 → 单 shard 无重叠", () => {
    const shards = shardChapters(chapters, 131072);
    expect(shards).toHaveLength(1);
    expect(shards[0]!.overlap).toEqual([]);
  });

  it("空输入 → 空", () => {
    expect(shardChapters([], 131072)).toEqual([]);
  });
});

describe("runBookReview", () => {
  const l2Llm = {
    complete: async (system: string, _user: string) => {
      if (system.includes("全文审校汇总者")) {
        return JSON.stringify({
          issues: [
            { type: "character_voice", severity: "medium", chapterIds: ["ch001", "ch002"], paragraphIds: ["p0001"], found: "爱丽丝语气平淡", repairInstruction: "让爱丽丝台词更活泼", suggestedAction: "revise_chapter" },
          ],
        });
      }
      // L2 窗口：报告一个跨章术语漂移
      return JSON.stringify({
        findings: [
          { chapterId: "ch001", type: "term_drift", severity: "high", paragraphIds: ["p0001"], found: "愛麗絲", expected: "爱丽丝", rubric: 2, evidence: "ch001 p0001 用了繁体", repairInstruction: "统一为爱丽丝" },
        ],
      });
    },
  };

  it("L0/L1 + L2 + Reduce → 报告落盘（含结构）", async () => {
    const result = await runBookReview(ws, { llm: l2Llm, contextWindow: 131072 });
    expect(result.report.issues.length).toBeGreaterThan(0);
    // L0/L1：ch001 术语正常（爱丽丝一致）→ 无 term_missing；可能无 L0 问题
    // L2/Reduce：character_voice 合并 ch001+ch002
    const voice = result.report.issues.find((i) => i.type === "character_voice");
    expect(voice).toBeDefined();
    expect(voice!.chapterIds).toContain("ch001");
    expect(result.report.summary).toMatchObject({ high: expect.any(Number), medium: expect.any(Number) });
    // 落盘
    expect(existsSync(result.reportPath)).toBe(true);
    expect(existsSync(join(dir, "reviews", "book", result.runId, "manifest.json"))).toBe(true);
    expect(existsSync(join(dir, "reviews", "book", "current.json"))).toBe(true);
    const stored = JSON.parse(await readFile(result.reportPath, "utf8"));
    expect(stored.reportId).toBe(result.report.reportId);
    expect(stored.rubricVersion).toBe(1);
  });

  it("Reduce 返回空 → 代码去重兜底", async () => {
    const llm = {
      complete: async (system: string) => {
        if (system.includes("全文审校汇总者")) return "{}";
        return JSON.stringify({ findings: [
          { chapterId: "ch002", type: "count_mismatch", severity: "medium", paragraphIds: ["p0001"], found: "爱丽丝", expected: "爱丽丝", rubric: 2, evidence: "x" },
          { chapterId: "ch002", type: "count_mismatch", severity: "medium", paragraphIds: ["p0001"], found: "爱丽丝", expected: "爱丽丝", rubric: 2, evidence: "y" },
        ] });
      },
    };
    const result = await runBookReview(ws, { llm, contextWindow: 131072 });
    const cm = result.report.issues.filter((i) => i.type === "count_mismatch");
    expect(cm).toHaveLength(1); // 去重
    expect(cm[0]!.suggestedAction).toBe("revise_chapter");
  });

  it("scope 限定章节", async () => {
    const result = await runBookReview(ws, { llm: l2Llm, scope: ["ch001"], contextWindow: 131072 });
    expect(result.report.scope).toEqual(["ch001"]);
  });

  it("markdown fallback 按 catalog 读取卷内原文", async () => {
    await writeFile(join(dir, "source", "manifest.json"), JSON.stringify({ book: "测试书", chapters: [
      { id: "ch001", title: "一", volume: "v01" },
    ] }));
    await mkdir(join(dir, "source", "v01"), { recursive: true });
    await writeFile(join(dir, "source", "v01", "ch001.md"), "巻内の原文。", "utf8");
    await mkdir(join(dir, "translations"), { recursive: true });
    await writeFile(join(dir, "translations", "ch001_zh.md"), "卷内译文。", "utf8");
    await rm(join(dir, "state", "paragraphs", "ch001.json"), { force: true });
    const users: string[] = [];
    const llm = {
      complete: async (system: string, user: string) => {
        users.push(user);
        return system.includes("全文审校汇总者") ? JSON.stringify({ issues: [] }) : JSON.stringify({ findings: [] });
      },
    };
    await runBookReview(ws, { llm, scope: ["ch001"], contextWindow: 131072 });
    expect(users.some((user) => user.includes("巻内の原文。"))).toBe(true);
  });

  it("P2-6：输入未变 → 复用上次报告（不重复 LLM 调用）", async () => {
    let calls = 0;
    const llm = {
      complete: async (system: string) => {
        calls += 1;
        if (system.includes("全文审校汇总者")) return JSON.stringify({ issues: [] });
        return JSON.stringify({ findings: [] });
      },
    };
    const first = await runBookReview(ws, { llm, contextWindow: 131072 });
    expect(calls).toBeGreaterThan(0);
    const callsBeforeSecond = calls;
    const second = await runBookReview(ws, { llm, contextWindow: 131072 });
    expect(second.runId).toBe(first.runId);
    expect(second.report.reportId).toBe(first.report.reportId);
    expect(calls).toBe(callsBeforeSecond); // 未新增 LLM 调用
  });

  it("P2-3：全文审校使用源修正内容并记录 sourceRevision", async () => {
    await mkdir(join(dir, "state", "source-corrections"), { recursive: true });
    await writeFile(join(dir, "state", "source-corrections", "ch001.json"), JSON.stringify({ revision: 2, source: "修正後の原文。", previousSource: "", savedAt: Date.now() }));
    const users: string[] = [];
    const llm = {
      complete: async (system: string, user: string) => {
        users.push(user);
        if (system.includes("全文审校汇总者")) return JSON.stringify({ issues: [] });
        return JSON.stringify({ findings: [
          { chapterId: "ch001", type: "term_drift", severity: "high", paragraphIds: ["p0001"], found: "x", expected: "y", rubric: 2, evidence: "e" },
        ] });
      },
    };
    const result = await runBookReview(ws, { llm, contextWindow: 131072 });
    const ch001Issues = result.report.issues.filter((i) => i.chapterIds.includes("ch001"));
    expect(ch001Issues.length).toBeGreaterThan(0);
    expect(ch001Issues[0]!.sourceRevision).toBe(2);
    expect(users.some((user) => user.includes("修正後の原文。"))).toBe(true);
  });

  // EX-08：原「overlap 带阅读轮 digest」的用例删除——阅读轮随译前提取链退役，
  // 那个文件不再有人写。下面这条原本是它的降级分支，现在是唯一路径。
  it("PL-15：overlap 只带该章译文前 500 字符，不重发全文", async () => {
    const users: string[] = [];
    const llm = {
      complete: async (system: string, user: string) => {
        users.push(user);
        return system.includes("全文审校汇总者") ? JSON.stringify({ issues: [] }) : JSON.stringify({ findings: [] });
      },
    };
    await runBookReview(ws, { llm, contextWindow: 40 });
    const second = users.find((user) => user.startsWith("章节范围：ch003"));
    expect(second).toBeDefined();
    expect(second).toContain("爱丽丝笑了。"); // 译文摘录
    expect(second).not.toContain("アリスが笑う。"); // 源文不再重发
  });

  it("PL-15：分片并行执行，findings 仍按 shard 顺序汇总", async () => {
    let active = 0;
    let maxActive = 0;
    const delayOf: Record<string, number> = { ch001: 60, ch002: 30, ch003: 5 };
    const llm = {
      complete: async (system: string, user: string) => {
        if (system.includes("全文审校汇总者")) return "{}"; // 走代码去重兜底，保留 shard 顺序
        active += 1;
        maxActive = Math.max(maxActive, active);
        const chapterId = /章节范围：(ch\d+)/.exec(user)?.[1] ?? "ch001";
        await new Promise((r) => setTimeout(r, delayOf[chapterId] ?? 5));
        active -= 1;
        return JSON.stringify({
          findings: [
            { chapterId, type: "term_drift", severity: "low", found: chapterId, expected: "x", rubric: 2, evidence: "e" },
          ],
        });
      },
    };
    // 窗口 20 → 目标 8 token：每章一个 shard
    const result = await runBookReview(ws, { llm, contextWindow: 20 });
    expect(maxActive).toBeGreaterThan(1);
    expect(result.report.shards.map((s) => s.shardId)).toEqual(["shard-01", "shard-02", "shard-03"]);
    expect(result.report.shards.map((s) => s.chapterIds)).toEqual([["ch001"], ["ch002"], ["ch003"]]);
    const l2 = result.report.issues.filter((i) => i.issueId.startsWith("l2_"));
    expect(l2.map((i) => i.chapterIds[0])).toEqual(["ch001", "ch002", "ch003"]);
  });

  it("P2：单章超出上下文窗口 → 抛错（不截断审校）", async () => {
    const huge = "あ".repeat(200000);
    await writeChapterParagraphs(ws, "ch001", [{ id: "p0001", type: "body", source: huge, translation: huge }], { staging: true, baseRevision: 1 });
    await expect(runBookReview(ws, { llm: l2Llm, contextWindow: 131072 })).rejects.toThrow(/上下文窗口/);
  });
});

/**
 * Q2-G5：全书审校两处静默截断——
 * ① 术语表按存储顺序切前 80 条，界面上写着"术语表（节选）"，作者无从知道哪些没进去；
 * ② findings 超 200 条时，Reduce 只看前 200，多出来的连一句提示都没有。
 * 本文件其余用例证明这条链路在正常规模下是对的，这两条守的是超规模时不许说谎。
 */
describe("规模超限时的诚实（术语节选 / findings 截断）", () => {
  it("术语超 80 条：按频次取，且 prompt 标签写出真实比例", async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      ja: `語${i}`,
      zh: `词${i}`,
      type: "term",
      count: i, // 語119 最高频
    }));
    await writeFile(join(dir, "terminology", "terms.json"), JSON.stringify(many));
    let shardUser = "";
    await runBookReview(ws, {
      llm: {
        complete: async (system: string, user: string) => {
          if (!system.includes("全文审校汇总者")) shardUser = user;
          return JSON.stringify({ findings: [] });
        },
      },
      contextWindow: 131072,
    });
    expect(shardUser).toContain("80/121"); // 120 + fixture 里的 アリス
    expect(shardUser).toContain("語119");  // 高频词在
    expect(shardUser).not.toContain("語0（"); // 最低频的不在（带边界字符避免误匹配 語0..語9）
  });

  it("findings 超 200 条：Reduce 前告警说明只汇总了前 200", async () => {
    const progress: string[] = [];
    await runBookReview(ws, {
      llm: {
        complete: async (system: string) => {
          if (system.includes("全文审校汇总者")) return JSON.stringify({ issues: [] });
          return JSON.stringify({
            findings: Array.from({ length: 250 }, (_, i) => ({
              chapterId: "ch001",
              type: "term_drift",
              severity: "low",
              paragraphIds: ["p0001"],
              found: `问题${i}`,
              expected: "x",
              rubric: 1,
              evidence: "e",
              repairInstruction: "r",
            })),
          });
        },
      },
      contextWindow: 131072,
      onProgress: (_phase, message) => { progress.push(message); },
    });
    expect(progress.some((m) => m.includes("200"))).toBe(true);
  });
});
