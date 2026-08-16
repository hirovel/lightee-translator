/**
 * 段落门禁与局部 patch（BQ-02）。
 *
 * 门禁职责（docs/specs/backend-quality-closure.md §2.5）：
 * - Translator 输出必须与源 canonical 段落一一对应（ID 集合/顺序/数量一致）。
 * - 校验失败 → 不写入 staging → 结构恢复（只修标签，不改正文）→ 仍失败 → 受控重译。
 * - 局部修订以受版本保护的 patch 原子写入段落权威文件。
 *
 * 段落权威文件：state/paragraphs/{chapterId}.json（revision + paragraphs）
 * Markdown 投影：translations/staging/{chapterId}_zh.md（由段落生成）
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "@lightee/core/atomic-fs";
import { stagingTranslationPath } from "./chapter-fs.ts";
import {
  parseParagraphsXml,
  validateParagraphOrder,
  paragraphsToText,
  type ParagraphBlock,
  type ParagraphWireError,
  type ParagraphType,
} from "@lightee/core/paragraph";
import type { Workspace } from "./workspace.ts";

// ===== 门禁 =====

export interface ParagraphGateResult {
  ok: boolean;
  /** 通过门禁的译段（ID/顺序与源一致） */
  paragraphs: ParagraphBlock[];
  errors: ParagraphWireError[];
  /** 是否经过结构恢复 */
  recovered: boolean;
}

/**
 * 只修复标签结构、不改译文正文：
 * - CRLF 统一
 * - 属性空格（id = "x" → id="x"）
 * - 剥外层代码块
 * - 补齐缺失的 </paragraph> 闭合
 */
export function repairParagraphsXml(xml: string): string {
  let out = xml.replace(/\r\n?/g, "\n");
  out = out.replace(/id\s*=\s*"/g, 'id="').replace(/type\s*=\s*"/g, 'type="');
  // 真实模型偶发写成 </<paragraph> 或把标签名误写为 parameter；只修标签字符，不触碰译文正文。
  // parameter 的修正限定在标签位置：开标签须处于行首或紧接上一标签之后且带 id 属性，
  // 闭标签须收在行尾或下一标签之前——否则正文里谈论 `<parameter>` 的句子会被一并改写。
  out = out
    .replace(/<\/\s*<paragraph\s*>/gi, "</paragraph>")
    .replace(/(^|\n|>)(\s*)<parameter(?=\s+id=")/gi, "$1$2<paragraph")
    .replace(/<\/parameter>(?=\s*(?:<|$))/gi, "</paragraph>");
  out = out.replace(/^```(?:xml)?\s*/i, "").replace(/\s*```$/, "");
  const opens = out.split("<paragraph").length - 1;
  const closes = out.split("</paragraph>").length - 1;
  if (closes === 0 && opens > 0) {
    // 完全没有闭合标签：按开标签重新切分每段，逐段补闭合（避免嵌套误读）
    out = out.replace(
      /<paragraph\s+id="([^"]+)"(?:\s+type="([^"]+)")?>([\s\S]*?)(?=<paragraph\s+id=|$)/g,
      (_m, id: string, type: string | undefined, content: string) =>
        `<paragraph id="${id}"${type ? ` type="${type}"` : ""}>${content.trimEnd()}</paragraph>`
    );
  } else if (closes < opens) {
    // 部分缺失 → 末尾补齐（保守）
    out += "</paragraph>".repeat(opens - closes);
  }
  return out;
}

/**
 * 门禁判定：parse（必要时 repair 后重 parse）→ 顺序/数量校验。
 * 只有 malformed/empty 会触发 repair；duplicate/unknown_type/顺序错误 repair 修不了 → 直接失败。
 */
export function gateTranslationOutput(xml: string, expectedIds: string[]): ParagraphGateResult {
  let recovered = false;
  let { paragraphs, errors } = parseParagraphsXml(xml);
  let orderErrors = validateParagraphOrder(paragraphs, expectedIds);
  const initialErrorCount = errors.length + orderErrors.length;

  // 宽松解析可能把错误闭合后的下一段吞进正文，却不产生 malformed。
  // 只要当前门禁失败，就尝试确定性结构修复；候选必须严格减少错误数才采用。
  if (initialErrorCount > 0) {
    const repaired = repairParagraphsXml(xml);
    if (repaired !== xml) {
      const candidate = parseParagraphsXml(repaired);
      const candidateOrderErrors = validateParagraphOrder(candidate.paragraphs, expectedIds);
      if (candidate.errors.length + candidateOrderErrors.length < initialErrorCount) {
        recovered = true;
        paragraphs = candidate.paragraphs;
        errors = candidate.errors;
        orderErrors = candidateOrderErrors;
      }
    }
  }

  const all = [...errors, ...orderErrors];
  return { ok: all.length === 0, paragraphs, errors: all, recovered };
}

// ===== 段落权威存储 =====

export interface ChapterParagraph {
  id: string;
  type: ParagraphType;
  source: string;
  translation: string;
  /**
   * 这一段的译文出自谁（R3-2）。缺省视同 model。
   *
   * 标 human 的段落是作者亲手改过的，任何自动通道都不得覆盖它：
   * 整章重译会保留原译文，局部修订会跳过。没有这个标记的话，
   * 作者精修过的一段会被一次「重新翻译」无声抹掉——这是最难被发现、
   * 也最伤人的一类数据损失。
   */
  translatedBy?: "model" | "human";
  /**
   * 这一段被确定性通道自动改写过，等待作者复查（EX-06 追溯改名）。
   *
   * 自动替换再窄也只是**确定性上说得通**：旧译名换成新译名之后读起来通不通顺、
   * 会不会撞上重复称呼，得作者说了算。标记留在段落权威里，审校面板据此提示。
   */
  recheck?: { reason: string; at: number };
}

export interface ChapterParagraphsFile {
  revision: number;
  chapterId: string;
  paragraphs: ChapterParagraph[];
}

export function paragraphsPath(ws: Workspace, chapterId: string): string {
  return join(ws.root, "state", "paragraphs", `${chapterId}.json`);
}

/** 读取段落权威文件（不存在 → null） */
export async function readChapterParagraphs(ws: Workspace, chapterId: string): Promise<ChapterParagraphsFile | null> {
  const path = paragraphsPath(ws, chapterId);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(await readFile(path, "utf-8")) as ChapterParagraphsFile;
    if (!Array.isArray(raw.paragraphs)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** 原子写入段落权威文件（revision 递增；md 投影同步生成） */
export async function writeChapterParagraphs(
  ws: Workspace,
  chapterId: string,
  paragraphs: ChapterParagraph[],
  opts: { baseRevision?: number; staging?: boolean } = {}
): Promise<ChapterParagraphsFile> {
  const existing = await readChapterParagraphs(ws, chapterId);
  if (opts.baseRevision !== undefined && (existing?.revision ?? 0) !== opts.baseRevision) {
    throw new Error(`段落版本冲突: 当前 ${existing?.revision ?? 0}, 期望 ${opts.baseRevision}`);
  }
  const revision = (existing?.revision ?? 0) + 1;
  const file: ChapterParagraphsFile = { revision, chapterId, paragraphs };
  await mkdir(join(ws.root, "state", "paragraphs"), { recursive: true });
  await atomicWriteFile(paragraphsPath(ws, chapterId), JSON.stringify(file, null, 2) + "\n");
  // Markdown 投影（UI/审校沿用现有 md 读取路径；段落 JSON 是权威）
  const md = paragraphsToText(paragraphs.map((p) => ({ id: p.id, type: p.type, text: p.translation })));
  const target = opts.staging
    ? stagingTranslationPath(ws.root, chapterId)
    : join(ws.root, "translations", `${chapterId}_zh.md`);
  if (opts.staging) await mkdir(join(ws.root, "state", "staging"), { recursive: true });
  await atomicWriteFile(target, md ? `${md}\n` : "");
  return file;
}

// ===== 局部 patch =====

export interface ParagraphPatchChange {
  paragraphId: string;
  translation: string;
  resolvedIssueIds?: string[];
}

export interface ParagraphPatch {
  chapterId: string;
  baseRevision: number;
  changes: ParagraphPatchChange[];
}

export interface ParagraphPatchResult {
  revision: number;
  paragraphs: ChapterParagraph[];
  /** 因为是作者手改而被跳过的段落 id（R3-2） */
  skippedHumanParagraphs: string[];
}

/**
 * 应用局部修订 patch：
 * - baseRevision 必须与段落权威文件当前 revision 一致（防覆盖作者/并发修改）。
 * - 每个 paragraphId 必须存在；只修改指定段，不新增/删除段落。
 * - 原子写回 + 同步 md 投影。
 */
export async function applyParagraphPatch(ws: Workspace, patch: ParagraphPatch): Promise<ParagraphPatchResult> {
  const file = await readChapterParagraphs(ws, patch.chapterId);
  if (!file) throw new Error(`段落文件不存在: ${patch.chapterId}`);
  if (file.revision !== patch.baseRevision) {
    throw new Error(`段落版本冲突: 当前 ${file.revision}, patch 期望 ${patch.baseRevision}`);
  }
  if (patch.changes.length === 0) throw new Error("空 patch：没有要修订的段落");

  const byId = new Map(file.paragraphs.map((p) => [p.id, p]));
  const updated = file.paragraphs.map((p) => ({ ...p }));
  const skippedHumanParagraphs: string[] = [];
  for (const change of patch.changes) {
    const target = byId.get(change.paragraphId);
    if (!target) throw new Error(`patch 引用未知段落: ${change.paragraphId}`);
    if (typeof change.translation !== "string" || change.translation.trim().length === 0) {
      throw new Error(`patch 段落 ${change.paragraphId} 译文为空`);
    }
    // R3-2：作者手改过的段落不接受自动修订。跳过而不是抛错——
    // 一个 patch 里混着人改段与机翻段时，机翻段该照常修好。
    if (target.translatedBy === "human") {
      skippedHumanParagraphs.push(change.paragraphId);
      continue;
    }
    const index = updated.findIndex((p) => p.id === change.paragraphId);
    updated[index] = { ...updated[index]!, translation: change.translation, translatedBy: "model" };
  }
  if (skippedHumanParagraphs.length === patch.changes.length) {
    throw new Error(`patch 的全部段落都是人工段，需手动处理: ${skippedHumanParagraphs.join(", ")}`);
  }

  const written = await writeChapterParagraphs(ws, patch.chapterId, updated, {
    baseRevision: patch.baseRevision,
    staging: true,
  });
  return { revision: written.revision, paragraphs: written.paragraphs, skippedHumanParagraphs };
}

// re-export 供调用方使用
export type { ParagraphWireError };
