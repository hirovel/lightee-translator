/**
 * 局部修订（BQ-03）—— Translator 的 revision_mode=passages。
 *
 * 输入：目标段落 ID + 每段的问题清单。
 * 输出：只含被修订段落的译文（wire XML），由调用方组装 patch 原子写入。
 *
 * 设计（docs/specs/backend-quality-closure.md §2.1）：
 * - 全新独立上下文，不继承初译推理过程。
 * - 只接收相关原文/当前译文/前后文/术语/指南/问题，不接收无关章节。
 * - 输出段落 id 必须 ⊆ 授权段落集合；不修改未授权段落。
 * - 段内自由组织句子，禁止跨段合并/拆分。
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TerminologyRepository } from "@lightee/core/terminology-repository";
import { parseParagraphsXml } from "@lightee/core/paragraph";
import type { Workspace } from "./workspace.ts";
import type { PipelineConfig } from "./cli-pipeline.ts";
import {
  DEFAULT_GUIDE,
  buildTranslatorSystem,
  buildChapterPunBlock,
  buildPreferenceBlock,
  type TranslateLlm,
} from "./translate-one.ts";
import { readChapterParagraphs, type ChapterParagraph } from "./paragraph-gate.ts";
import { applyPostTransforms } from "./post-transform.ts";
import { buildNoTranslateLines, readDictionaries } from "./dictionary.ts";
import { renderTermLine } from "./term-prefix.ts";
import { resolvePersonas } from "./persona.ts";
import { resolveChapter } from "./chapter-fs.ts";

export interface RevisePassageItem {
  paragraphId: string;
  issues: string[];
}

export interface RevisePassageChange {
  paragraphId: string;
  translation: string;
  resolvedIssueIds?: string[];
}

const REVISE_OUTPUT_RULE = `【输出格式】只输出需要修订的段落，返回：<paragraph id="原文段落id">修订后的译文</paragraph>。每段独立成行。严格规则：
- 段落 id 必须是本次修订清单中的 id。
- 不要修改清单之外的段落；不要新增、删除、合并或拆分段落。
- 只输出被修订段落；某段无需修改则不输出该段。
- 段内允许自由组织句子，但不得跨段。
- 除 id 外不要输出其他属性，不要输出本说明。`;

/** 读 JSON（容错） */
async function readJson<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

export async function reviseChapterPassages(
  ws: Workspace,
  chapterId: string,
  items: RevisePassageItem[],
  llm: TranslateLlm,
  config: PipelineConfig,
  opts: { model?: string } = {}
): Promise<RevisePassageChange[]> {
  const resolved = await resolveChapter(ws, chapterId);
  const file = await readChapterParagraphs(ws, chapterId);
  if (!file) throw new Error(`段落文件不存在: ${chapterId}`);
  const all = file.paragraphs;
  const byId = new Map(all.map((p) => [p.id, p]));
  const authorized = new Set(items.map((i) => i.paragraphId));
  for (const id of authorized) {
    if (!byId.has(id)) throw new Error(`修订段落不存在: ${id}`);
  }

  // 术语（与初译一致：按章子集，无索引回退全量）
  const terminology = await new TerminologyRepository(ws.root).readSnapshot();
  const dicts = readDictionaries(terminology.archives);
  const allTerms: Array<{ ja: string; zh: string; type: string }> = [
    ...terminology.archives.names,
    ...terminology.archives.terms,
  ] as Array<{ ja: string; zh: string; type: string }>;
  // EX-05：与主翻通道同一注入形态——累积词表全表、发现顺序追加、永不重排。
  // 逐章子集在一张边翻边长的表上是反效果（每章行集合都不同 → 前缀缓存章章落空）。
  const injectTerms = allTerms;

  // 本章原文（段落权威文件的 source 面）——双关与作者偏好都按它过滤
  const chapterSource = all.map((p) => p.source).join("\n\n");
  const { cleanZhHint } = await import("./pun-detect.ts");
  const puns = (terminology.archives.puns as Array<{ ja: string; zh?: string; note?: string }>).map((p) => ({
    ...p,
    zh: cleanZhHint(p.zh),
  }));

  // PL-22：与主翻通道同一组装函数，修订模式只换自己的输出规则。
  // 缺双关档案/作者偏好时，局部修订会把主翻遵守的约束改丢。
  const system = buildTranslatorSystem({
    mode: "revise",
    guide: config.translation.guide ?? DEFAULT_GUIDE,
    // EX-08 / D4：全书概览退役（阅读轮不再存在，且梗概对译文质量无帮助）
    outputRule: REVISE_OUTPUT_RULE,
    ...(config.translation.styleAnchor ? { styleAnchor: config.translation.styleAnchor } : {}),
    termBlock: [
      // 与初译同一注入写法（含人设）：两条路径写法不同，修订会把初译遵守的人称与语气改掉
      injectTerms.map((t) => renderTermLine(t, resolvePersonas(terminology.archives))).join("\n"),
      buildNoTranslateLines(dicts.noTranslate, chapterSource),
    ].filter(Boolean).join("\n"),
    prefBlock: await buildPreferenceBlock(ws, llm, config, chapterId, resolved.entry.volume, chapterSource),
    punBlock: buildChapterPunBlock(puns, chapterSource),
  });

  // 组装修订请求：每段给 问题 + 原文 + 当前译文 + 前后文（各 1 段只读）
  const blocks = items.map((item) => {
    const p = byId.get(item.paragraphId)!;
    const idx = all.findIndex((x) => x.id === item.paragraphId);
    const prev = idx > 0 ? all[idx - 1]! : null;
    const next = idx < all.length - 1 ? all[idx + 1]! : null;
    const ctx = (x: ChapterParagraph | null) => (x ? `（id=${x.id}）${x.translation}` : "（无）");
    return `【待修订段 ${item.paragraphId}】
问题：
${item.issues.map((i) => `- ${i}`).join("\n")}
原文：
${p.source}
当前译文：
${p.translation}
前段译文: ${ctx(prev)}
后段译文: ${ctx(next)}`;
  });

  const user = `以下章节有 ${items.length} 个待修订段落。请逐段修订（只输出修订段）：\n\n${blocks.join("\n\n")}`;

  const model = opts.model ?? config.agents.translator?.model ?? "deepseek/deepseek-v4-pro";
  const thinking = config.agents.translator?.thinking ?? "high";
  const res = await llm.complete(model, [
    { role: "system", content: system },
    { role: "user", content: user },
  ], { thinking });
  if (!res.text.trim()) throw new Error("局部修订返回空");

  const { paragraphs, errors } = parseParagraphsXml(res.text);
  // 输出段落必须全部在授权集合内（允许子集）
  for (const p of paragraphs) {
    if (!authorized.has(p.id)) throw new Error(`局部修订输出了未授权段落: ${p.id}`);
  }
  // malformed/duplicate 等结构错误 → 拒绝
  if (errors.length > 0 && paragraphs.length > 0) {
    throw new Error(`局部修订输出结构错误: ${errors.map((e) => `${e.code}: ${e.message}`).join("；")}`);
  }
  if (errors.some((e) => e.code === "empty")) throw new Error("局部修订返回空（无任何段落）");

  // 修订段与初译走同一 L0 出口（R0-1 / R1-1），否则修订会把整章引号风格与译后字典的结果改花
  const quoteStyle = config.translation.quoteStyle ?? "zh";
  return paragraphs.map((p) => ({
    paragraphId: p.id,
    translation: applyPostTransforms(p.text, { quoteStyle, postDict: dicts.postDict }),
  }));
}
