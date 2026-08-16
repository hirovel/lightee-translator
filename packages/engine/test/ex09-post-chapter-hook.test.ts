/**
 * 章后钩子（EX-09）—— 质量检测/润色的挂载点。
 *
 * 本票不实现任何质量能力，只保证挂载点存在且语义正确：每章翻译成功后调用一次、
 * 拿得到译文与本章提取增量、失败时降级告警而**不阻塞主循环**。
 *
 * 为什么要现在就把这个位置钉死：作者已经决定后续加入检测与润色。等到能力到位再改
 * 主循环，就要在一条已经承载了漂移检测、修复阶梯、promote 崩溃恢复的路径上动刀。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runChapterPipeline, type ChapterHookContext } from "../src/chapter-pipeline.js";
import type { PipelineConfig } from "../src/cli-pipeline.js";
import { toolLlm, toolLlmWithRawArgs } from "./helpers/tool-llm.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const CONFIG: PipelineConfig = {
  project: { name: "t", srcLang: "ja", tgtLang: "zh" },
  agents: {},
  translation: { mode: "balanced", concurrency: 1, batchChars: 2000 },
};

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lightee-hook-"));
  roots.push(root);
  await mkdir(join(root, "source", "v01"), { recursive: true });
  await mkdir(join(root, "terminology"), { recursive: true });
  await writeFile(join(root, "source", "manifest.json"), JSON.stringify({ chapters: [{ id: "ch001", volume: "v01" }] }), "utf8");
  await writeFile(join(root, "source", "v01", "ch001.md"), "アリスとボブが笑った。", "utf8");
  await writeFile(join(root, "terminology", "names.json"), JSON.stringify([{ ja: "アリス", zh: "爱丽丝" }]), "utf8");
  return root;
}

/** 译文 + 工具通道登记一个新词（KA-5：术语走 register_terms，不再有尾块） */
function fakeLlm() {
  return toolLlm({ terms: [{ ja: "ボブ", zh: "鲍勃", type: "person" }] });
}

describe("章后钩子（EX-09）", () => {
  it("每章翻译成功后调用一次，拿到译文、本章增量与累积词表", async () => {
    const root = await makeWorkspace();
    const seen: ChapterHookContext[] = [];

    const result = await runChapterPipeline({ root }, "ch001", fakeLlm() as never, CONFIG, {
      postChapter: (context) => { seen.push(context); },
    });

    expect(result.outcome.state).toBe("approved");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.chapterId).toBe("ch001");
    expect(seen[0]!.translation).toContain("爱丽丝笑了");
    // 本章融合提取的增量到得了钩子手上（アリス 已在词表里，被补救层按 known 丢弃——这正是期望行为）
    expect(seen[0]!.newTerms.map((term) => term.ja)).toEqual(["ボブ"]);
    // 累积词表（截至本章）同样在手
    expect(seen[0]!.glossary).toContainEqual({ ja: "アリス", zh: "爱丽丝" });
  });

  it("钩子抛错 → onWarn 一条，译文照常交付（不阻塞主循环）", async () => {
    const root = await makeWorkspace();
    const warnings: string[] = [];

    const result = await runChapterPipeline({ root }, "ch001", fakeLlm() as never, CONFIG, {
      onWarn: (message) => warnings.push(message),
      postChapter: () => { throw new Error("检测器炸了"); },
    });

    expect(result.outcome.state).toBe("approved");
    expect(warnings.some((message) => message.includes("章后检查") && message.includes("检测器炸了"))).toBe(true);
  });

  it("钩子返回的 notes 作为建议外传，且一个字都不进译文", async () => {
    const root = await makeWorkspace();
    const warnings: string[] = [];

    await runChapterPipeline({ root }, "ch001", fakeLlm() as never, CONFIG, {
      onWarn: (message) => warnings.push(message),
      postChapter: () => ({ notes: ["第 2 段读起来有点硬"] }),
    });

    expect(warnings.some((message) => message.includes("第 2 段读起来有点硬"))).toBe(true);
    const { readFile } = await import("node:fs/promises");
    const translation = await readFile(join(root, "translations", "ch001_zh.md"), "utf8");
    expect(translation).not.toContain("读起来有点硬");
  });

  it("不挂钩子 = 零行为变化", async () => {
    const root = await makeWorkspace();
    const result = await runChapterPipeline({ root }, "ch001", fakeLlm() as never, CONFIG, {
    });
    expect(result.outcome.state).toBe("approved");
  });
});

/**
 * EX-04 收尾：融合提取的降级告警必须**说出来**。
 *
 * 「译文照常交付，但少了什么要让作者知道」是本仓库反复付过学费的一条纪律：
 * 幻觉词被丢弃、尾块解析失败、整章一个尾块都没输出——这三种情况在产出上
 * 与「本章确实没有新词」完全一样，不上报就永远不会被发现。
 */
describe("融合提取降级告警接到 onWarn", () => {
  it("幻觉词（不在原文里）被丢弃时告警", async () => {
    const root = await makeWorkspace();
    const warnings: string[] = [];
    const llm = toolLlm({ terms: [{ ja: "存在しない名前", zh: "不存在", type: "person" }], render: () => "译文。" });
    await runChapterPipeline({ root }, "ch001", llm as never, CONFIG, {
      onTranslateWarn: (message) => warnings.push(message),
    });
    expect(warnings.some((m) => m.includes("找不到") && m.includes("存在しない名前"))).toBe(true);
  });

  it("工具参数整体不可用时告警（不是静默丢弃）", async () => {
    const root = await makeWorkspace();
    const warnings: string[] = [];
    const llm = toolLlmWithRawArgs("抱歉，我无法完成这个请求。" as never, () => "译文。");
    await runChapterPipeline({ root }, "ch001", llm as never, CONFIG, {
      onTranslateWarn: (message) => warnings.push(message),
    });
    expect(warnings.some((m) => m.includes("工具参数不是对象"))).toBe(true);
  });

  it("模型明确回空 terms → 不告警（「本章没有新词」是有效答案）", async () => {
    const root = await makeWorkspace();
    const warnings: string[] = [];
    await runChapterPipeline({ root }, "ch001", toolLlm({ terms: [], render: () => "译文。" }) as never, CONFIG, {
      onTranslateWarn: (message) => warnings.push(message),
    });
    expect(warnings).toEqual([]);
  });

  it("onTranslateWarn 缺省时回退到 onWarn（不静默）", async () => {
    const root = await makeWorkspace();
    const warnings: string[] = [];
    const llm = toolLlmWithRawArgs("坏数据" as never, () => "译文。");
    await runChapterPipeline({ root }, "ch001", llm as never, CONFIG, {
      onWarn: (message) => warnings.push(message),
    });
    expect(warnings.some((m) => m.includes("工具参数不是对象"))).toBe(true);
  });

  it("哑火检测：够长的章节一次工具都没调 → 告警（EX-03 P2）", async () => {
    const root = await makeWorkspace();
    const { writeFile } = await import("node:fs/promises");
    // 1000 字，超过 MIN_CHARS_FOR_TERMS_EXPECTED
    await writeFile(join(root, "source", "v01", "ch001.md"), "アリスが笑った。".repeat(125), "utf8");
    const warnings: string[] = [];
    await runChapterPipeline({ root }, "ch001", toolLlm({ skipTool: true, render: () => "译文。" }) as never, CONFIG, {
      onTranslateWarn: (message) => warnings.push(message),
    });
    expect(warnings.some((m) => m.includes("一次 register_terms 都没调用"))).toBe(true);
  });

  it("短章节没调工具 → 不告警（标题页本来就没有新词，别制造噪音）", async () => {
    const root = await makeWorkspace();
    const warnings: string[] = [];
    await runChapterPipeline({ root }, "ch001", toolLlm({ skipTool: true, render: () => "译文。" }) as never, CONFIG, {
      onTranslateWarn: (message) => warnings.push(message),
    });
    expect(warnings).toEqual([]);
  });
});
