/**
 * review-one —— 单章审校（TUI /review 用真实 reviewer-scan）。
 * L0/L1 代码检查（术语/引号/未译/注音残留/pun 译注）+ 问题列表输出。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Workspace } from "./workspace.ts";
import { resolveChecksRun, scanAllChapters } from "./reviewer-scan.ts";
import { TerminologyRepository } from "@lightee/core/terminology-repository";
import { readDictionaries } from "./dictionary.ts";
import { readChapterParagraphs } from "./paragraph-gate.ts";
import { resolveChapter } from "./chapter-fs.ts";

export interface ReviewOneResult {
  chapterId: string;
  issueCount: number;
  issues: Array<{
    type: string;
    severity: string;
    found?: string;
    expected?: string;
    location: string;
    dialogueSafe: boolean;
    /** 权威定位：这条问题落在哪一段（RV-04）。UI 靠它跳转，修订靠它取范围。 */
    paragraphId?: string;
    /** 同一条问题涉及的全部段落；`paragraphId` 是其中第一个。 */
    paragraphIds?: string[];
    /** 术语类问题涉及的日文词——UI 据此提供「打开术语条目」。 */
    termJa?: string;
  }>;
  /**
   * 本次实际执行了哪些检查（RV-04）。「N 项检查全部通过」的 N 必须来自这里，
   * 否则界面会把没跑过的检查也算成通过。
   */
  checksRun: string[];
  /**
   * 本章根本没有可审校的译文（RV-01）。
   *
   * 「查过了没问题」和「没东西可查」是两件事，从前它们共用 issueCount:0 这一个出口，
   * 于是刚翻完、尚未定稿的章节点「审校本章」会得到一个假的绿勾。调用方必须先看这个字段。
   */
  noTranslation?: boolean;
}

export interface ReviewChapterOptions {
  quoteStyle?: "zh" | "jp";
  /** 审校 staging 文本而不将其暴露为 approved translation。 */
  translationOverride?: string;
  /**
   * 与 translationOverride 配套的段落权威数据（RV-02）。
   *
   * 翻译管线在审校前刚用 paragraph-gate 写完这批段落，它与 override 文本是同一份产物；
   * 传进来，六项段落检查才跑得到。不传时的旧行为（读盘/不跑）保持不变。
   */
  paragraphsOverride?: ReadonlyArray<{ id: string; source: string; translation: string }>;
  /**
   * 降级告警。目前只有自定义规则轮会用：它失败时不阻塞其余检查，
   * 但作者必须知道这一项没查成，否则「N 项检查全部通过」是句谎话。
   */
  onWarn?: (message: string) => void;
}

export async function reviewChapter(
  ws: Workspace,
  chapterId: string,
  opts: ReviewChapterOptions = {}
): Promise<ReviewOneResult> {
  const resolved = await resolveChapter(ws, chapterId);
  const source = await readFile(resolved.paths.source, "utf-8");
  // translations/{id}_zh.md 只在两种情况下存在：章节 approved 时从 staging 提升，
  // 或作者在编辑器里保存过。翻完但没定稿、也没手动改过的章节，译文只躺在 staging，
  // 那才是此刻该被审校的文本（RV-01）。
  const stagingPath = resolved.paths.staging;
  const readablePath = existsSync(resolved.paths.translation)
    ? resolved.paths.translation
    : existsSync(stagingPath) ? stagingPath : null;
  if (readablePath === null && opts.translationOverride === undefined) {
    return { chapterId, issueCount: 0, issues: [], checksRun: [], noTranslation: true };
  }
  const translation = opts.translationOverride ?? await readFile(readablePath!, "utf-8");

  // Canonical terminology snapshot；legacy JSON is only a projection.
  // names/terms 两个档案在这里不再读：最后一条术语检查（count_mismatch）删除之后，
  // 审校侧对词表**一次都不查**——一致性由翻译时的注入兑现，不是事后扫描。
  const terminology = await new TerminologyRepository(ws.root).readSnapshot();
  const puns = terminology.archives.puns as Array<{ ja: string; zh?: string; note?: string }>;
  const { noTranslate } = readDictionaries(terminology.archives);

  // 段落权威数据（R3-1/R4-1 六项按段检查的输入）。
  // 调用方给了 paragraphsOverride 就用它——那是本次门禁刚产出的段落，与 override 文本同源。
  // 没给且在审校 override 文本时仍然不读盘：落盘段落可能与被审文本不是同一版，
  // 按错的对照去判会报出一堆假问题。
  const paragraphs = opts.paragraphsOverride
    ?? (opts.translationOverride === undefined ? (await readChapterParagraphs(ws, chapterId))?.paragraphs : undefined);

  const issues = scanAllChapters(
    [{
      id: chapterId,
      source,
      translation,
      ...(paragraphs && paragraphs.length > 0 ? { paragraphs: [...paragraphs] } : {}),
    }],
    opts.quoteStyle ?? "zh",
    puns,
    { noTranslate }
  );

  // CHK-02：自定义规则轮已删除。文字写成的规则**判不出**模型有没有遵守——
  // 那一轮把「像是违规」当成「违规」，而作者拿到的是一条无从核对的判定。
  // 真要发现问题，走 QE-01 的译文对照，不走一条自我裁定的检查。
  // 至此 reviewChapter **零 LLM 调用**：审校只做结构事实的确定性扫描。

  return {
    chapterId,
    issueCount: issues.length,
    issues: issues.map((i) => ({
      type: i.type,
      severity: i.severity,
      found: i.found,
      expected: i.expected,
      location: i.location,
      dialogueSafe: "dialogueSafe" in i && i.dialogueSafe === true,
      ...(i.paragraphIds?.[0] ? { paragraphId: i.paragraphIds[0], paragraphIds: i.paragraphIds } : {}),
      ...(i.termJa ? { termJa: i.termJa } : {}),
    })),
    checksRun: resolveChecksRun({
      // 只数**真的会被检查**的梗：留空译注的那些已经在扫描里跳过了，
      // 把它们算进「N 项检查全部通过」就是把没跑的检查报成通过（RV-04 判过死刑的那种谎话）。
      puns: puns.filter((p) => p.zh && p.note?.trim()).length,
      noTranslate: noTranslate.length,
      hasParagraphs: Boolean(paragraphs && paragraphs.length > 0),
    }),
  };
}
