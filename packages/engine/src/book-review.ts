/**
 * 全文 Reviewer Map-Reduce（BQ-05）。
 *
 * 流程（docs/specs/backend-quality-closure.md §2.3）：
 *   L0/L1 全量确定性扫描（scanAllChapters，零 token，天然全书视角）
 *   → L2 连续章节/段落自适应 shard（目标约 context 40%，边界重叠一章）
 *   → Reduce 汇总（只读 shard findings + 摘要，去重/跨 shard 冲突）
 *   → 报告落盘 reviews/book/<runId>/...
 *
 * 报告协议（规格 §3）：
 *   reviews/book/<runId>/manifest.json
 *   reviews/book/<runId>/shards/<shardId>.json
 *   reviews/book/<runId>/report.json
 *   reviews/book/current.json
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "@lightee/core/atomic-fs";
import { extractJsonPayload } from "@lightee/core/json-fence";
import { scanAllChapters, type ScanIssue } from "./reviewer-scan.ts";
import { readDictionaries } from "./dictionary.ts";
import { TerminologyRepository } from "@lightee/core/terminology-repository";
import { readChapterParagraphs, type ChapterParagraph } from "./paragraph-gate.ts";
import type { Workspace } from "./workspace.ts";
import { readChapterCatalog, resolveChapter } from "./chapter-fs.ts";

// ===== 类型 =====

export type BookReviewSeverity = "high" | "medium" | "low";
export type BookReviewAction = "replace_all" | "revise_chapter" | "review_again" | "ignore" | "request_human";

export interface BookReviewIssue {
  issueId: string;
  type: string;
  severity: BookReviewSeverity;
  rubricVersion: number;
  chapterIds: string[];
  paragraphIds?: string[];
  found?: string;
  expected?: string;
  evidenceRefs: Array<{ source: string; context: string }>;
  suggestedAction: BookReviewAction;
  repairInstruction?: string;
  sourceRevision: number;
  translationRevision: number;
  preferenceIds?: string[];
}

export interface BookReviewShard {
  shardId: string;
  chapterIds: string[];
  /** 重叠章节（前一 shard 的尾部，仅作审校输入；汇总去重） */
  overlapChapterIds: string[];
  estTokens: number;
}

export interface BookReviewReport {
  reportId: string;
  runId: string;
  book: string;
  generatedAt: string;
  scope: string[];
  rubricVersion: number;
  summary: { high: number; medium: number; low: number };
  issues: BookReviewIssue[];
  shards: Array<{ shardId: string; chapterIds: string[]; issueCount: number }>;
}

export interface BookReviewRunInput {
  llm: { complete: (system: string, user: string) => Promise<string> };
  /** 审校范围（章节 id 列表；缺省全书） */
  scope?: string[];
  /**
   * 作者自定的审校规则（settings `review.rules`）。CHK-02 删掉单章自定规则轮之后，
   * 这里是它唯一的诚实落点：注入通读窗口逐条对照，产出仍是**建议**进 advice 列表
   * 由作者终审——不是自我裁定的检查项，与 CHK-02 的裁定不冲突。
   */
  authorRules?: Array<{ name: string; rule: string }>;
  contextWindow?: number;
  maxL2Calls?: number;
  /** 进度回调（BQ-06 事件用） */
  onProgress?: (phase: "scan" | "shard" | "reduce", message: string, done: number, total: number) => void | Promise<void>;
}

export interface BookReviewResult {
  runId: string;
  report: BookReviewReport;
  reportPath: string;
}

// ===== 常量 =====

const RUBRIC_VERSION = 1;
const TARGET_RATIO = 0.4;
/** 分片并发上限：分片之间无数据依赖，串行只是把全书审校时延乘以分片数 */
const SHARD_CONCURRENCY = 4;
/** 无阅读轮梗概时，重叠章节的退化摘要长度 */
const OVERLAP_FALLBACK_CHARS = 500;

const RUBRIC = `1. 准确性与完整性：误译、漏译、增译、人物/事件/时间线事实错误。
2. 术语与跨章一致性：权威术语、人物称呼、专名、口癖、拟声词、译注是否统一。
3. 语篇与角色声音：指代、视角、人物语气、场景衔接、跨章逻辑。
4. 流畅性与可读性：中文自然度、轻小说节奏、重复、生硬语序、对话质量。
5. 结构与格式：段落一一对应、标题、分隔符、插图标记、引号、待审标记。`;

// ===== 分片 =====

export function estTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

/**
 * 连续章节自适应分片：目标约 context*ratio token；尽量保持完整章节；
 * 相邻 shard 重叠末尾 1 章（作审校输入，Reduce 去重）。
 */
export function shardChapters(
  chapters: Array<{ id: string; source: string; translation: string }>,
  contextWindow: number,
  targetRatio = TARGET_RATIO
): Array<{ base: Array<{ id: string; source: string; translation: string }>; overlap: string[] }> {
  if (chapters.length === 0) return [];
  const target = Math.max(1, Math.floor(contextWindow * targetRatio));
  const shards: Array<{ base: Array<{ id: string; source: string; translation: string }>; overlap: string[] }> = [];
  let current: Array<{ id: string; source: string; translation: string }> = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length === 0) return;
    shards.push({ base: current, overlap: [] });
    current = [];
    currentTokens = 0;
  };

  for (const ch of chapters) {
    const t = estTokens(ch.source) + estTokens(ch.translation);
    if (current.length > 0 && currentTokens + t > target) flush();
    current.push(ch);
    currentTokens += t;
  }
  flush();

  // 边界重叠：每个 shard（除首个）在 base 前加入前一 shard 最后 1 章
  for (let i = 1; i < shards.length; i++) {
    const prev = shards[i - 1]!.base;
    if (prev.length > 0) {
      shards[i]!.overlap = [prev[prev.length - 1]!.id];
    }
  }
  return shards;
}

// ===== L2 窗口审校 =====

interface L2Finding {
  chapterId: string;
  type: string;
  severity: BookReviewSeverity;
  paragraphIds?: string[];
  found?: string;
  expected?: string;
  rubric: number;
  evidence?: string;
  repairInstruction?: string;
}

const L2_SYSTEM = `你是轻小译的全文审校者（窗口审校）。审校给定章节窗口的中文译文，按固定 rubric 检查：

${RUBRIC}

输出严格 JSON：{"findings":[{ "chapterId","type","severity":"high|medium|low","paragraphIds":[可选],"found","expected","rubric":1-5,"evidence":"证据/位置","repairInstruction":"可执行修订要求" }]}
- 只报告真实问题；每条必须绑定 rubric 维度 + 证据。
- 无法定位到段落的「整体风格」问题 severity 不得为 high。
- 不输出 JSON 之外内容。`;

function parseL2Findings(raw: string): L2Finding[] {
  try {
    const parsed = extractJsonPayload(raw) as { findings?: Array<Record<string, unknown>> };
    return (parsed.findings ?? []).map((f) => ({
      chapterId: typeof f.chapterId === "string" ? f.chapterId : "",
      type: typeof f.type === "string" ? f.type : "unknown",
      severity: (f.severity === "high" || f.severity === "medium" || f.severity === "low") ? f.severity as BookReviewSeverity : "low" as const,
      paragraphIds: Array.isArray(f.paragraphIds) ? f.paragraphIds.filter((x): x is string => typeof x === "string") : undefined,
      found: typeof f.found === "string" ? f.found : undefined,
      expected: typeof f.expected === "string" ? f.expected : undefined,
      rubric: typeof f.rubric === "number" ? f.rubric : 0,
      evidence: typeof f.evidence === "string" ? f.evidence : undefined,
      repairInstruction: typeof f.repairInstruction === "string" ? f.repairInstruction : undefined,
    })).filter((f) => f.chapterId && f.type !== "unknown");
  } catch {
    return [];
  }
}

// ===== Reduce 汇总 =====

const REDUCE_SYSTEM = `你是轻小译的全文审校汇总者。接收各章节窗口的结构化 findings，生成全书统一审校报告。

任务：
1. 按稳定 fingerprint（chapterId + type + found）去重（同一问题被多个窗口报告只保留一条，合并证据）。
2. 合并跨章节同一术语/人物的不一致问题（chapterIds 合并）。
3. 为每条最终 finding 给 suggestedAction：replace_all（机械替换，有 expected/found）/ revise_chapter（局部修订，有 paragraphIds）/ review_again / ignore（证据不足）/ request_human（无法自动裁决）。
4. 只基于提供的 findings 和证据，不要臆造。

输出严格 JSON：{"issues":[{"type","severity","chapterIds":[..],"paragraphIds":[可选],"found","expected","evidenceRefs":[{"source","context"}],"repairInstruction","suggestedAction"}]}`;

interface ReducedIssue {
  type: string;
  severity: BookReviewSeverity;
  chapterIds: string[];
  paragraphIds?: string[];
  found?: string;
  expected?: string;
  evidenceRefs: Array<{ source: string; context: string }>;
  repairInstruction?: string;
  suggestedAction: BookReviewAction;
}

function parseReduced(raw: string): ReducedIssue[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { issues?: Array<Record<string, unknown>> };
    return (parsed.issues ?? []).map((i) => ({
      type: typeof i.type === "string" ? i.type : "unknown",
      severity: (i.severity === "high" || i.severity === "medium" || i.severity === "low") ? i.severity as BookReviewSeverity : "low" as const,
      chapterIds: Array.isArray(i.chapterIds) ? i.chapterIds.filter((x): x is string => typeof x === "string") : [],
      paragraphIds: Array.isArray(i.paragraphIds) ? i.paragraphIds.filter((x): x is string => typeof x === "string") : undefined,
      found: typeof i.found === "string" ? i.found : undefined,
      expected: typeof i.expected === "string" ? i.expected : undefined,
      evidenceRefs: Array.isArray(i.evidenceRefs) ? i.evidenceRefs.map((e) => ({ source: String((e as { source?: unknown }).source ?? ""), context: String((e as { context?: unknown }).context ?? "") })) : [],
      repairInstruction: typeof i.repairInstruction === "string" ? i.repairInstruction : undefined,
      suggestedAction: (i.suggestedAction === "replace_all" || i.suggestedAction === "revise_chapter" || i.suggestedAction === "review_again" || i.suggestedAction === "ignore" || i.suggestedAction === "request_human") ? i.suggestedAction as BookReviewAction : "review_again" as const,
    })).filter((i) => i.type !== "unknown" && i.chapterIds.length > 0);
  } catch {
    return [];
  }
}

// ===== 章节数据读取 =====

interface ReviewChapterData {
  id: string;
  source: string;
  translation: string;
  paragraphs: ChapterParagraph[];
  translationRevision: number;
  /** 源版本：source-corrections 修正 revision（无修正 = 0） */
  sourceRevision: number;
}

async function loadChapterData(ws: Workspace, chapterId: string): Promise<ReviewChapterData> {
  const resolved = await resolveChapter(ws, chapterId);
  const paras = await readChapterParagraphs(ws, chapterId);
  // 源版本：source-corrections 修正 revision（无修正 = 0）
  let sourceRevision = 0;
  let correctedSource: string | undefined;
  const corrPath = resolved.paths.correction;
  if (existsSync(corrPath)) {
    try {
      const corr = JSON.parse(await readFile(corrPath, "utf-8")) as { revision?: number; source?: unknown };
      if (typeof corr.revision === "number" && Number.isFinite(corr.revision)) sourceRevision = corr.revision;
      if (typeof corr.source === "string") correctedSource = corr.source;
    } catch {
      // 损坏修正文件 → 源版本 0
    }
  }
  if (paras && paras.paragraphs.length > 0) {
    return {
      id: chapterId,
      source: correctedSource ?? paras.paragraphs.map((p) => p.source).join("\n\n"),
      translation: paras.paragraphs.map((p) => p.translation).join("\n\n"),
      paragraphs: paras.paragraphs,
      translationRevision: paras.revision,
      sourceRevision,
    };
  }
  // fallback：canonical markdown 文件
  const translation = existsSync(resolved.paths.translation) ? await readFile(resolved.paths.translation, "utf-8") : "";
  const source = correctedSource ?? await readFile(resolved.paths.source, "utf-8");
  return { id: chapterId, source, translation, paragraphs: [], translationRevision: 0, sourceRevision };
}

// ===== 主流程 =====

export async function runBookReview(
  ws: Workspace,
  options: BookReviewRunInput
): Promise<BookReviewResult> {
  const runId = randomUUID();
  const contextWindow = options.contextWindow ?? 131072;
  const maxL2 = options.maxL2Calls ?? 16;

  const catalog = await readChapterCatalog(ws);
  const scope = options.scope?.length ? options.scope : catalog.entries.map((chapter) => chapter.id);

  // 术语 + puns + 作者偏好
  const terminology = await new TerminologyRepository(ws.root).readSnapshot();
  const terminologyRevision = terminology.revision ?? 0;
  // count 是术语档案本来就有的字段（TermEntryLite.count），这里显式收进类型：
  // 术语表节选要按频次取，而不是按存储顺序切一刀。
  const terms: Array<{ ja: string; zh: string; type: string; count?: number }> = [
    ...terminology.archives.names,
    ...terminology.archives.terms,
  ] as Array<{ ja: string; zh: string; type: string; count?: number }>;
  const puns = terminology.archives.puns as Array<{ ja: string; zh?: string; note?: string }>;

  // 作者偏好 profile 版本（无偏好 = 0）
  let preferenceProfileVersion = 0;
  const prefPath = join(ws.root, "state", "author-preferences.json");
  if (existsSync(prefPath)) {
    try {
      const pp = JSON.parse(await readFile(prefPath, "utf-8")) as { profileVersion?: number };
      if (typeof pp.profileVersion === "number" && Number.isFinite(pp.profileVersion)) preferenceProfileVersion = pp.profileVersion;
    } catch {
      // 损坏偏好 profile → 版本 0
    }
  }

  const chapterData: ReviewChapterData[] = [];
  for (const id of scope) chapterData.push(await loadChapterData(ws, id));

  // —— P2-6：输入未变（源/译文/术语/偏好版本一致）→ 复用上次报告（幂等，不重复烧 token）——
  const currentPath = join(ws.root, "reviews", "book", "current.json");
  if (existsSync(currentPath)) {
    try {
      const cur = JSON.parse(await readFile(currentPath, "utf-8")) as { runId?: string; reportPath?: string };
      if (cur.runId && cur.reportPath) {
        const prevManifestPath = join(ws.root, "reviews", "book", cur.runId, "manifest.json");
        if (existsSync(prevManifestPath) && existsSync(cur.reportPath)) {
          const prev = JSON.parse(await readFile(prevManifestPath, "utf-8")) as {
            scope?: string[];
            revisions?: Record<string, { translation?: number; source?: number }>;
            terminologyRevision?: number;
            preferenceProfileVersion?: number;
          };
          const sameScope = JSON.stringify(prev.scope ?? []) === JSON.stringify(scope);
          const sameRevs = chapterData.length > 0 && chapterData.every((c) => {
            const r = prev.revisions?.[c.id];
            return r && r.translation === c.translationRevision && (r.source ?? 0) === c.sourceRevision;
          });
          const sameInputs = sameScope && sameRevs
            && prev.terminologyRevision === terminologyRevision
            && prev.preferenceProfileVersion === preferenceProfileVersion;
          if (sameInputs) {
            const report = JSON.parse(await readFile(cur.reportPath, "utf-8")) as BookReviewReport;
            if (report?.runId) return { runId: cur.runId, report, reportPath: cur.reportPath };
          }
        }
      }
    } catch {
      // 缓存损坏 → 重跑
    }
  }

  // —— L0/L1 全量确定性扫描（零 token）——
  const scanIssues: ScanIssue[] = scanAllChapters(
    // 段落权威数据一并传入：R3-1 的五项检查按段判定，拿整章字符串比会把正常语序调整误判
    chapterData.map((c) => ({ id: c.id, source: c.source, translation: c.translation, paragraphs: c.paragraphs })),
    "zh",
    puns,
    { noTranslate: readDictionaries(terminology.archives).noTranslate }
  );

  // —— L2 窗口审校 ——
  await options.onProgress?.("scan", "全量确定性扫描完成", 0, 1);
  // 超长单章 fail-closed：超出上下文窗口上限 → 抛错（不得截断审校）
  for (const c of chapterData) {
    if (estTokens(c.source) + estTokens(c.translation) > contextWindow) {
      throw new Error(`章节 ${c.id} 超出上下文窗口上限（${contextWindow}）→ 无法全文审校；请增大上下文窗口或拆分章节`);
    }
  }
  const shardInputs = shardChapters(
    chapterData.map((c) => ({ id: c.id, source: c.source, translation: c.translation })),
    contextWindow
  );
  type ShardResult = { shard: { shardId: string; chapterIds: string[]; overlapChapterIds: string[] }; findings: L2Finding[] };
  const shardResults: ShardResult[] = new Array<ShardResult>(shardInputs.length);
  // fail-closed：超上限的窗口不得静默跳过；并行下必须在发起任何调用前判定
  if (shardInputs.length > maxL2) {
    throw new Error(`全文审校窗口数超过上限 ${maxL2}（第 ${maxL2 + 1}/${shardInputs.length} 个窗口未审）→ 报告不完整`);
  }
  // 术语节选：按频次取高频词，标签写出真实比例。
  // 此前按存储顺序切前 80 条并标"（节选）"——作者读到的是一个看不出边界的谎：
  // 既不知道漏了哪些，也不知道漏了多少。
  const TERM_BRIEF_LIMIT = 80;
  const termCount = (t: { count?: number }): number => (typeof t.count === "number" ? t.count : 0);
  const briefTerms = [...terms].sort((a, b) => termCount(b) - termCount(a)).slice(0, TERM_BRIEF_LIMIT);
  const termBrief = briefTerms.map((t) => `${t.ja}→${t.zh}`).join("，");
  const termBriefLabel = terms.length > TERM_BRIEF_LIMIT
    ? `术语表（按频次节选 ${briefTerms.length}/${terms.length}）`
    : `术语表（${terms.length}）`;

  const reviewShard = async (i: number): Promise<ShardResult> => {
    const s = shardInputs[i]!;
    const shardId = `shard-${String(i + 1).padStart(2, "0")}`;
    const chapterIds = s.base.map((c) => c.id);
    const shardChaptersText = s.base
      .map((c) => `【${c.id}】\n原文：\n${c.source}\n译文：\n${c.translation}`)
      .join("\n\n---\n\n");
    // 重叠章节只给梗概：它的全文已在上一窗口审过，重发一遍纯粹是重复计费。
    // EX-08：阅读轮梗概退役后统一取译文开头——衔接判断只需要知道上一章收在哪里。
    const overlapBrief = s.overlap
      .map((id) => {
        const data = chapterData.find((c) => c.id === id);
        if (!data) return "";
        const digest = data.translation.slice(0, OVERLAP_FALLBACK_CHARS);
        return digest.trim() ? `【${id}】${digest.trim()}` : "";
      })
      .filter((line) => line.length > 0);
    const overlapText = overlapBrief.length > 0
      ? `\n\n【重叠衔接章节梗概】（仅作前后文参考，不计入本窗口问题）\n${overlapBrief.join("\n")}`
      : "";
    // 作者规则注入每个窗口：规则命中与否由作者终审（findings 本来就是建议），
    // LLM 只负责按规则找出候选位置。
    const authorRulesText = (options.authorRules ?? []).length > 0
      ? `\n作者审校规则（逐条对照译文，疑似违反即报 finding，注明规则名）：\n${(options.authorRules ?? [])
          .map((rule, index) => `${index + 1}. 【${rule.name}】${rule.rule}`)
          .join("\n")}`
      : "";
    const user = `章节范围：${chapterIds.join(", ")}${s.overlap.length ? `（含重叠章节 ${s.overlap.join(",")} 作衔接上下文）` : ""}
${termBriefLabel}：${termBrief || "（无）"}${authorRulesText}

${shardChaptersText}${overlapText}

请输出该窗口的 findings（JSON）。`;
    const raw = await options.llm.complete(L2_SYSTEM, user);
    const findings = parseL2Findings(raw);
    // fail-closed：LLM 返回了内容但无法解析出 findings → 视为审校失败（不得当作“无问题”）
    const l2ValidEmpty = (() => {
      try {
        const start = raw.indexOf("{");
        const end = raw.lastIndexOf("}");
        if (start < 0 || end <= start) return false;
        const parsed = JSON.parse(raw.slice(start, end + 1)) as { findings?: unknown };
        return Array.isArray(parsed.findings);
      } catch {
        return false;
      }
    })();
    if (findings.length === 0 && raw.trim().length > 0 && !l2ValidEmpty) {
      throw new Error(`全文审校窗口 ${shardId} 输出无法解析（响应 ${raw.length} 字符）→ 审校失败`);
    }
    // 落盘 shard 结果
    await mkdir(join(ws.root, "reviews", "book", runId, "shards"), { recursive: true });
    await atomicWriteFile(
      join(ws.root, "reviews", "book", runId, "shards", `${shardId}.json`),
      JSON.stringify({ shardId, chapterIds, overlapChapterIds: s.overlap, findings }, null, 2) + "\n"
    );
    return { shard: { shardId, chapterIds, overlapChapterIds: s.overlap }, findings };
  };

  // 分片并行；结果按下标回填，汇总顺序与分片顺序一致（缓存指纹依赖 findings 顺序稳定）
  let nextShard = 0;
  let doneShards = 0;
  let shardFailure: unknown;
  const workers = Array.from({ length: Math.min(SHARD_CONCURRENCY, shardInputs.length) }, async () => {
    while (nextShard < shardInputs.length && shardFailure === undefined) {
      const i = nextShard++;
      try {
        shardResults[i] = await reviewShard(i);
        doneShards += 1;
        await options.onProgress?.("shard", `窗口 ${i + 1}/${shardInputs.length} 审校完成`, doneShards, shardInputs.length);
      } catch (error) {
        shardFailure ??= error;
      }
    }
  });
  await Promise.all(workers);
  if (shardFailure !== undefined) throw shardFailure;

  // —— Reduce 汇总 ——
  const allFindings = shardResults.flatMap((r) => r.findings);
  let reduced: ReducedIssue[] = [];
  if (allFindings.length > 0) {
    // Reduce 只喂前 200 条。超出部分不是丢失（全部 findings 已按 shard 落盘），
    // 但"汇总报告里没有"与"没这个问题"对读者是一回事，必须说出来。
    const REDUCE_FINDINGS_LIMIT = 200;
    if (allFindings.length > REDUCE_FINDINGS_LIMIT) {
      await options.onProgress?.(
        "reduce",
        `findings 共 ${allFindings.length} 条，超过 ${REDUCE_FINDINGS_LIMIT} 条上限，汇总只覆盖前 ${REDUCE_FINDINGS_LIMIT} 条；完整清单见 reviews/book/${runId}/shards/`,
        0,
        1,
      );
    }
    const findingsBrief = JSON.stringify(allFindings.slice(0, REDUCE_FINDINGS_LIMIT), null, 1);
    const raw = await options.llm.complete(REDUCE_SYSTEM, `窗口 findings：\n${findingsBrief}`);
    reduced = parseReduced(raw);
    // fail-closed：Reduce 返回了内容但完全无法解析为 JSON → 审校失败（不得用空结果冒充通过）
    // 合法 JSON 但结构不符（如 {}）→ 仍走代码去重兜底（不丢数据）
    const reduceValid = (() => {
      try {
        const start = raw.indexOf("{");
        const end = raw.lastIndexOf("}");
        if (start < 0 || end <= start) return false;
        JSON.parse(raw.slice(start, end + 1));
        return true;
      } catch {
        return false;
      }
    })();
    if (reduced.length === 0 && !reduceValid) {
      throw new Error(`全文审校 Reduce 输出无法解析（响应 ${raw.length} 字符）→ 审校失败`);
    }
    await options.onProgress?.("reduce", "Reduce 汇总完成", 1, 1);
  }
  // Reduce 失败/空 → 代码去重兜底（按 fingerprint）
  if (reduced.length === 0 && allFindings.length > 0) {
    const seen = new Set<string>();
    for (const f of allFindings) {
      const key = `${f.chapterId}|${f.type}|${f.found ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      reduced.push({
        type: f.type,
        severity: f.severity,
        chapterIds: [f.chapterId],
        paragraphIds: f.paragraphIds,
        found: f.found,
        expected: f.expected,
        evidenceRefs: f.evidence ? [{ source: f.chapterId, context: f.evidence }] : [],
        repairInstruction: f.repairInstruction,
        suggestedAction: f.paragraphIds?.length ? "revise_chapter" : "review_again",
      });
    }
  }

  // —— 组装报告（L0/L1 代码扫描 + L2/Reduce）——
  const revisionOf = (id: string): number => chapterData.find((c) => c.id === id)?.translationRevision ?? 0;
  const sourceRevisionOf = (id: string): number => chapterData.find((c) => c.id === id)?.sourceRevision ?? 0;
  const scanIssuesMapped: BookReviewIssue[] = scanIssues.map((si, idx) => ({
    issueId: `l0_${String(idx + 1).padStart(3, "0")}`,
    type: si.type,
    severity: si.severity,
    rubricVersion: RUBRIC_VERSION,
    chapterIds: [si.chapterId],
    paragraphIds: si.location ? undefined : undefined,
    found: si.found,
    expected: si.expected,
    evidenceRefs: si.evidence ?? [],
    suggestedAction: si.dialogueSafe && si.expected ? "replace_all" : "revise_chapter",
    sourceRevision: sourceRevisionOf(si.chapterId),
    translationRevision: revisionOf(si.chapterId),
  }));
  const l2IssuesMapped: BookReviewIssue[] = reduced.map((r, idx) => ({
    issueId: `l2_${String(idx + 1).padStart(3, "0")}`,
    type: r.type,
    severity: r.severity,
    rubricVersion: RUBRIC_VERSION,
    chapterIds: r.chapterIds,
    paragraphIds: r.paragraphIds,
    found: r.found,
    expected: r.expected,
    evidenceRefs: r.evidenceRefs,
    suggestedAction: r.suggestedAction,
    repairInstruction: r.repairInstruction,
    sourceRevision: r.chapterIds.map(sourceRevisionOf).reduce((a, b) => Math.max(a, b), 0),
    translationRevision: r.chapterIds.map(revisionOf).reduce((a, b) => Math.max(a, b), 0),
  }));

  const issues = [...scanIssuesMapped, ...l2IssuesMapped];
  const summary = { high: issues.filter((i) => i.severity === "high").length, medium: issues.filter((i) => i.severity === "medium").length, low: issues.filter((i) => i.severity === "low").length };

  const report: BookReviewReport = {
    reportId: `bookrev_${Date.now().toString(36)}`,
    runId,
    book: catalog.book ?? "无题",
    generatedAt: new Date().toISOString(),
    scope,
    rubricVersion: RUBRIC_VERSION,
    summary,
    issues,
    shards: shardResults.map((r) => ({ shardId: r.shard.shardId, chapterIds: r.shard.chapterIds, issueCount: r.findings.length })),
  };

  // —— 落盘 ——
  const dir = join(ws.root, "reviews", "book", runId);
  await mkdir(dir, { recursive: true });
  await atomicWriteFile(join(dir, "manifest.json"), JSON.stringify({
    runId,
    book: report.book,
    generatedAt: report.generatedAt,
    scope,
    rubricVersion: RUBRIC_VERSION,
    shards: report.shards,
    revisions: Object.fromEntries(chapterData.map((c) => [c.id, { translation: c.translationRevision, source: c.sourceRevision }])),
    terminologyRevision,
    preferenceProfileVersion,
  }, null, 2) + "\n");
  const reportPath = join(dir, "report.json");
  await atomicWriteFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  await atomicWriteFile(join(ws.root, "reviews", "book", "current.json"), JSON.stringify({ runId, reportPath, generatedAt: report.generatedAt }, null, 2) + "\n");

  return { runId, report, reportPath };
}
