/**
 * CLI 全流程 —— 把翻译链串成可运行流水线。
 *
 * 流程（ADR-0007 之后）: 读 catalog → Translator ×N（译文与术语同一次产出）
 *       → Reviewer → Orchestrator 调度。**没有译前提取阶段**，导入即可翻。
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TerminologyRepository } from "@lightee/core/terminology-repository";
import { runPipeline } from "./orchestrator.ts";
import { translateChapterToFile } from "./translate-one.ts";
import { chapterPaths, readChapterCatalog } from "./chapter-fs.ts";
import { readDictionaries } from "./dictionary.ts";
import { applyRenamePlan, planRenameForChapters } from "./rename-repair.ts";
import { readRenameEventsSince } from "./rename-log.ts";
import type { Workspace } from "./workspace.ts";
import type { LlmRuntime } from "./llm-runtime.ts";

export interface PipelineConfig {
  project: { name: string; srcLang: string; tgtLang: string };
  agents: Record<string, { model: string; thinking: string; fallbackModel?: string }>;
  translation: {
    mode: "parallel" | "balanced" | "quality";
    concurrency: number;
    batchChars: number;
    quoteStyle?: "zh" | "jp";
    contextWindow?: number;
    maxTokens?: number;
    guide?: string;
    staging?: boolean;
    /** 风格锚定参考文本（R2-3）：作者提供的目标语样本，进静态前缀 */
    styleAnchor?: string;
  };
}

// EX-08：TerminologyLlm / TerminologyPreparationOptions / TerminologyPhase /
// TerminologyPreparationResult 随译前提取链一并退役——没有那个阶段了，也就没有
// 它的入参、阶段枚举与产物形状。

export interface RunTranslateOptions {
  workspace: Workspace;
  config: PipelineConfig;
  llm: LlmRuntime;
  // EX-07 / ADR-0007：terminologyConfirmed / autoConfirm 随译前阶段一起退役。
  // 术语在翻译途中产生（EX-04），没有「开工前先确认完」这个节点了。
}

export interface RunTranslateResult {
  approved: string[];
  stuck: string[];
  /** 当前累积词表条数（names + terms）。翻译前后都可能变，只作展示。 */
  terminologyCount: number;
}

/**
 * 模型输出上限：优先取指定 agent 的配置，其次取工作区级配置；都没有则返回 undefined，
 * 由调用方省略该参数、落到注册表默认值。
 *
 * 放在这里是因为 PipelineConfig 在本模块声明。**这是唯一实现**——translate-one 曾有
 * 一份私有同名副本（agent 写死 translator），于是 preferenceCompiler 这类也发 LLM 调用的
 * 环节永远读不到自己的 maxTokens。注释当年就写着「翻译侧应改为引用本函数」，只是没人执行。
 */
export function configuredMaxTokens(config: PipelineConfig, agent: string): number | undefined {
  const candidates = [
    (config.agents[agent] as { maxTokens?: unknown } | undefined)?.maxTokens,
    (config.translation as { maxTokens?: unknown }).maxTokens,
  ];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/** 按 canonical catalog 归属读取章节原文。 */
async function loadChapter(ws: Workspace, id: string, volume?: string): Promise<string> {
  return readFile(chapterPaths(ws, { id, volume }).source, "utf-8");
}

// ===== 译前提取链在此退役（EX-08 / ADR-0007）=====
//
// 这里原本是 420 行的译前提取：通读全书 → L0 候选池 → 逐轮决策 → 语气归属两遍 →
// 复核轮 → 双关独立轮 → 生成决策卡。EX-03 的真实对照实验判了它死刑：
// L0 候选池按统计特征挑词，读不出语境，把「星の乙女」拆成「星」+「乙女」——
// 全书 59 次出现的世界观核心词从来就没进过候选；而形态学切分产出的
// 「はちょっ」「がちょっ」这类半个词，L3 还照样盖章 keep:true。
//
// 取而代之的是融合式提取（EX-04）：术语在翻译那次不可压缩的阅读里顺手产出，
// 边际输入为零，实测准确率 ≈98%（旧链 ≤60%）。

export async function runTranslate(options: RunTranslateOptions): Promise<RunTranslateResult> {
  const { workspace: ws, config, llm } = options;
  const catalog = await readChapterCatalog(ws);
  const chapterIds = catalog.entries.map((chapter) => chapter.id);
  // TP-4：飞行窗口起点（保守取 run 开始——只会多扫不会漏扫，重放幂等）
  const renameWatchStart = Date.now();

  // ===== 1. 读现有术语档案（翻译/审校用）=====
  //
  // EX-07 / ADR-0007：译前提取阶段在这里退役。原来这一段会在术语表为空时先跑一趟
  // 全书提取、再要求逐项确认才准开工；融合式提取之后术语随翻译逐章长出来，
  // **导入即可翻**。空表不是错误状态，只是第一章还没翻而已。
  const repository = new TerminologyRepository(ws.root);
  const terminologySnapshot = await repository.readSnapshot();
  const terminologyCount = terminologySnapshot.archives.names.length + terminologySnapshot.archives.terms.length;
  const puns = terminologySnapshot.archives.puns as Array<{ ja: string; zh?: string; note?: string }>;
  const { noTranslate } = readDictionaries(terminologySnapshot.archives);

  // ===== 2. Orchestrator 流水线（术语由 translateChapterToFile 按章索引注入）=====
  const result = await runPipeline({
    chapterIds,
    concurrency: config.translation.concurrency ?? 1,
    // CLI 与 App 走同一条翻译实现。此前这里是一份简化重复体（无段落门禁、无术语索引、
    // 无作者偏好、无分批），同一本书从两个入口进来会得到实质不同的译文。
    translate: async (chapterId, opts) => {
      const result = await translateChapterToFile(ws, chapterId, llm, config, opts?.retryNote, opts?.model);
      return { translation: result.translation, drifts: [], pendingTerms: result.pendingTerms };
    },
    review: async (ids) => {
      // 简化 review + puns 译注存在性检查（已确认梗缺译注 → pun_note_missing）
      // + 禁翻词存留检查（R1-3）
      if (puns.length > 0 || noTranslate.length > 0) {
        const { scanAllChapters } = await import("./reviewer-scan.ts");
        const chapters = [];
        for (const id of ids) {
          const meta = catalog.byId.get(id);
          if (!meta) throw new Error(`未知章节 ${id}`);
          const src = await loadChapter(ws, id, meta.volume);
          const trPath = join(ws.root, "translations", `${id}_zh.md`);
          const tr = existsSync(trPath) ? await readFile(trPath, "utf-8") : "";
          chapters.push({ id, source: src, translation: tr });
        }
        const scanIssues = scanAllChapters(chapters, config.translation.quoteStyle ?? "zh", puns, { noTranslate });
        // ScanIssue → ReviewerFn issue（补 suggestedAction: 缺译注需人工修正 → revise_chapter）
        return {
          issues: scanIssues.map((i) => ({
            id: i.id,
            type: i.type,
            severity: i.severity,
            chapterId: i.chapterId,
            expected: i.expected,
            found: i.found,
            dialogueSafe: i.dialogueSafe,
            suggestedAction: "revise_chapter" as const,
          })),
        };
      }
      return { issues: [] };
    },
  });

  // ===== TP-4 飞行中改名补扫（CLI 侧；App 侧在 chapter-pipeline）=====
  // run 期间发生的改名扫不到还没落盘的章；run 结束后对本次处理过的章按序重放。
  // 已被正常追溯改过的位置重放时找不到旧译名——幂等。补扫失败不改变 run 结局。
  try {
    const inflight = await readRenameEventsSince(ws, renameWatchStart);
    if (inflight.length > 0) {
      const snapshotAfter = await repository.readSnapshot();
      const allZh = [...snapshotAfter.archives.names, ...snapshotAfter.archives.terms]
        .map((entry) => (typeof entry.zh === "string" ? entry.zh : ""))
        .filter(Boolean);
      for (const chapterId of chapterIds) {
        for (const event of inflight) {
          const plan = await planRenameForChapters(ws, {
            ja: event.ja,
            oldZh: event.oldZh,
            newZh: event.newZh,
            otherZh: allZh.filter((zh) => zh !== event.newZh),
          }, [chapterId]);
          await applyRenamePlan(ws, plan);
        }
      }
    }
  } catch (error) {
    // 只记章数与原因分类，不进任何正文
    console.warn(`飞行中改名补扫失败（不影响译文交付）：${error instanceof Error ? error.message : String(error)}`);
  }

  return { approved: result.approved, stuck: result.stuck, terminologyCount };
}
