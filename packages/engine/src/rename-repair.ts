/**
 * 追溯改名（EX-06）—— 作者改一个术语的译法，已经翻好的章节要跟着改。
 *
 * ## 为什么不能直接全局替换
 *
 * RV-03 已经判过盲替换死刑：字符串替换看不见语境，一次「把 A 换成 B」能顺手毁掉
 * 一整章。但融合式提取（ADR-0007）让这件事变得非做不可——译前确认阶段拆掉之后，
 * 前面章节用的都是模型当场定的**临时译名**，作者后来改名却没有追溯机制的话，
 * 旧译名就永远留在正文里了。
 *
 * 所以这里走的是**窄门**：只有确定性上说得清「这一处替换绝不会出错」的位置才自动改，
 * 其余一律进复查队列由作者逐处确认。宁可让作者多点几下，也不要出一次静默损坏。
 *
 * ## 窄门的判据
 *
 * 1. **全局**：旧译名长度 ≥ 2。单字译名（「雏」）在中文里几乎必然是别的词的一部分，
 *    没有任何自动替换是安全的。
 * 2. **逐段**：段落不是作者手改过的（R3-2 `translatedBy === "human"`）。
 * 3. **逐处占位判定（TP-3 连带改名）**：先长后短——更长的在档译名先占住它在文本里的
 *    位置。旧译名的某处出现若**完全落在**更长词条的占位里（「星之圣女」里的「圣女」），
 *    它是那个词的一部分，跳过不动；若与其他译名**部分咬合**（「星之圣」与「圣女」在
 *    「星之圣女」里互相咬住一截），不属于任何一方，进复查由人裁。
 *
 * 原第二道全局判据（旧译名是其他译名的子串 → 整次改名零自动替换）已由占位判定取代：
 * 12 章实测里它拦下了 16%（14/87，含 3 个双字人名）——而「这个位置属于哪个词」
 * 是确定性判断，不需要把整次改名都推给人工。
 *
 * ## 没有段落权威文件的章节
 *
 * 旧数据里可能只有 `translations/*.md` 而没有 `state/paragraphs/*.json`。那种章节
 * 无法逐段判断人改保护，**整章进复查队列**而不是退回去改 md——绕过段落权威去改
 * Markdown 正是 BQ-02 建立门禁要杜绝的事。
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, readJson, withFileMutationQueue } from "@lightee/core/atomic-fs";
import { readChapterCatalog, stagingTranslationPath } from "./chapter-fs.ts";
import { readChapterParagraphs, writeChapterParagraphs, type ChapterParagraph } from "./paragraph-gate.ts";
import { appendRenameEvent } from "./rename-log.ts";
import type { Workspace } from "./workspace.ts";

/** 旧译名短于这个长度就不走自动替换：中文单字几乎必然是别的词的一部分 */
export const MIN_AUTO_RENAME_LENGTH = 2;
/** 复查条目里带的上下文半径（字符） */
const EXCERPT_RADIUS = 24;

/** 整次改名被窄门挡下的原因（挡下 = 零自动替换，全部进复查） */
export type RenameBlockReason = "too_short";

/**
 * 单处出现被排除在自动替换之外的原因。
 * `substring_of_term` 不再产生（TP-3 占位判定取代了全局子串封锁），
 * 保留字面量是为了老复查队列里的存量条目仍可读。
 */
export type RenameReviewReason = RenameBlockReason | "substring_of_term" | "human_edited" | "overlaps_term" | "no_paragraphs";

export interface RenameHit {
  chapterId: string;
  /** 无段落权威文件的章节为 `"*"`（整章待人工处理） */
  paragraphId: string;
  /** 段内旧译名出现次数 */
  count: number;
  /** 首处出现的上下文片段，供复查队列展示 */
  excerpt: string;
}

export interface RenameReviewItem extends RenameHit {
  reason: RenameReviewReason;
}

export interface RenamePlan {
  ja: string;
  oldZh: string;
  newZh: string;
  /** 其他在档译名（落地时要按占位判定重算安全位置，计划必须带着它） */
  otherZh: ReadonlyArray<string>;
  /** 全局窄门未过时的原因；有值时 `auto` 必为空 */
  blocked?: RenameBlockReason;
  /** 可自动替换的位置 */
  auto: RenameHit[];
  /** 必须人工确认的位置 */
  review: RenameReviewItem[];
}

export interface RenameApplyResult {
  /** 实际改写的段落数 */
  replaced: number;
  /** 实际改写的章节 id */
  chapters: string[];
  /** 入队的复查条目数 */
  queued: number;
}

// ===== 纯判定（可单测，无 IO） =====

/** 全局窄门：不过则整次改名零自动替换。子串封锁已由占位判定取代（TP-3） */
export function checkRenameGate(oldZh: string): RenameBlockReason | undefined {
  if (oldZh.length < MIN_AUTO_RENAME_LENGTH) return "too_short";
  return undefined;
}

/** 段内 oldZh 每处出现的占位分类（TP-3 连带改名的核心判定） */
export interface OccurrenceClaims {
  /** 可安全替换的起始下标 */
  free: number[];
  /** 完全被更长在档译名占住——那是别的词的一部分，跳过不动 */
  claimed: number[];
  /** 与其他译名部分咬合——不属于任何一方，人裁 */
  contested: number[];
}

/**
 * 占位判定：先长后短。更长的在档译名先占住它在文本里的区间（嵌套包含时
 * 最长者的占位覆盖一切），旧译名的每处出现再对照占位分类。
 * 完全落在旧译名内部的其他译名不算数——整串一起换掉，被包住的不会残留。
 */
export function claimOccurrences(text: string, oldZh: string, otherZh: ReadonlyArray<string>): OccurrenceClaims {
  const others = [...new Set(otherZh.filter((other) => other && other !== oldZh))].sort((a, b) => b.length - a.length);
  const occupied: Array<{ start: number; end: number; length: number }> = [];
  for (const other of others) {
    for (const start of occurrences(text, other)) {
      const end = start + other.length;
      // 已被更长者完全覆盖的区间不再登记——这就是「先长后短」
      if (occupied.some((range) => start >= range.start && end <= range.end)) continue;
      occupied.push({ start, end, length: other.length });
    }
  }
  const claims: OccurrenceClaims = { free: [], claimed: [], contested: [] };
  for (const start of occurrences(text, oldZh)) {
    const end = start + oldZh.length;
    const container = occupied.find((range) => start >= range.start && end <= range.end && range.length > oldZh.length);
    if (container) { claims.claimed.push(start); continue; }
    const contested = occupied.some((range) =>
      start < range.end && range.start < end && !(range.start >= start && range.end <= end));
    if (contested) claims.contested.push(start);
    else claims.free.push(start);
  }
  return claims;
}

/** 按起始下标做定点替换（从右往左，避免位移干扰） */
export function replaceAtPositions(text: string, starts: ReadonlyArray<number>, oldLength: number, replacement: string): string {
  let out = text;
  for (const start of [...starts].sort((a, b) => b - a)) {
    out = `${out.slice(0, start)}${replacement}${out.slice(start + oldLength)}`;
  }
  return out;
}

/** 文本里某个子串的全部起始下标（逐字、不重叠） */
function occurrences(text: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return out;
    out.push(at);
    from = at + needle.length;
  }
}

/**
 * 段内是否存在「与另一个术语译名部分重叠」的出现。
 *
 * 完全落在旧译名内部的其他术语不算重叠——整串一起换掉，被包住的那个不会残留。
 * 危险的是两边**互相咬住一截**（「星之圣」与「圣女」在「星之圣女」里），
 * 以及另一个译名**反过来包住**旧译名（那种全局判据已经挡过一道，这里是第二道）。
 */
export function overlapsOtherTerm(text: string, oldZh: string, otherZh: ReadonlyArray<string>): boolean {
  const mine = occurrences(text, oldZh).map((start) => ({ start, end: start + oldZh.length }));
  if (mine.length === 0) return false;
  for (const other of otherZh) {
    if (!other || other === oldZh) continue;
    for (const start of occurrences(text, other)) {
      const end = start + other.length;
      for (const range of mine) {
        const intersects = start < range.end && range.start < end;
        const containedInMine = start >= range.start && end <= range.end;
        if (intersects && !containedInMine) return true;
      }
    }
  }
  return false;
}

function excerptAround(text: string, needle: string): string {
  const at = text.indexOf(needle);
  if (at < 0) return text.slice(0, EXCERPT_RADIUS * 2);
  const from = Math.max(0, at - EXCERPT_RADIUS);
  const to = Math.min(text.length, at + needle.length + EXCERPT_RADIUS);
  return `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
}

/**
 * 逐段判定：返回 undefined 表示这一段可以自动替换（可替换位置由占位判定给出）。
 * 部分咬合的出现哪怕只有一处，整段进复查——半替换一段再让作者看剩下的，
 * 只会让「改了什么」说不清楚。
 */
export function classifyParagraph(
  paragraph: Pick<ChapterParagraph, "translation" | "translatedBy">,
  oldZh: string,
  otherZh: ReadonlyArray<string>,
): RenameReviewReason | undefined {
  if (paragraph.translatedBy === "human") return "human_edited";
  if (claimOccurrences(paragraph.translation, oldZh, otherZh).contested.length > 0) return "overlaps_term";
  return undefined;
}

// ===== 扫描 =====

export interface RenameInput {
  ja: string;
  oldZh: string;
  newZh: string;
  /** 词表里其他条目的译名（用于子串与重叠判定）。不含本条自己。 */
  otherZh: ReadonlyArray<string>;
}

/**
 * 扫描全部已翻章节，产出改名计划。**只读**，不写任何文件——
 * 计划先算清楚再落地，是为了让「改了哪些地方」在动手之前就能看见。
 */
export async function planRename(ws: Workspace, input: RenameInput): Promise<RenamePlan> {
  const catalog = await readChapterCatalog(ws);
  return planRenameForChapters(ws, input, catalog.entries.map((entry) => entry.id));
}

/**
 * 章范围版（TP-4 飞行中改名补扫用）：只扫给定的章。
 * 补扫的对象是「刚落盘的这一章」——全书扫描它已经做过一遍了。
 */
export async function planRenameForChapters(
  ws: Workspace,
  input: RenameInput,
  chapterIds: ReadonlyArray<string>,
): Promise<RenamePlan> {
  const { ja, oldZh, newZh } = input;
  const plan: RenamePlan = { ja, oldZh, newZh, otherZh: [...input.otherZh], auto: [], review: [] };
  if (!oldZh || oldZh === newZh) return plan;

  const blocked = checkRenameGate(oldZh);
  if (blocked) plan.blocked = blocked;

  for (const chapterId of chapterIds) {
    const file = await readChapterParagraphs(ws, chapterId);
    if (!file) {
      // 没有段落权威 → 无法判断人改保护，整章交给作者
      const hit = await legacyChapterHit(ws, chapterId, oldZh);
      if (hit) plan.review.push({ ...hit, reason: "no_paragraphs" });
      continue;
    }
    for (const paragraph of file.paragraphs) {
      const claims = claimOccurrences(paragraph.translation, oldZh, input.otherZh);
      // 全部出现都被更长词条占住 → 这一段与本次改名无关，auto 与复查都不进
      const relevant = claims.free.length + claims.contested.length;
      if (relevant === 0) continue;
      const hit: RenameHit = {
        chapterId,
        paragraphId: paragraph.id,
        count: relevant,
        excerpt: excerptAround(paragraph.translation, oldZh),
      };
      const reason = plan.blocked ?? classifyParagraph(paragraph, oldZh, input.otherZh);
      if (reason) plan.review.push({ ...hit, reason });
      else plan.auto.push(hit);
    }
  }
  return plan;
}

/** 只有 md、没有段落权威的历史章节：确认旧译名确实在里面，好让复查队列指得出地方 */
async function legacyChapterHit(ws: Workspace, chapterId: string, oldZh: string): Promise<RenameHit | null> {
  for (const path of [
    join(ws.root, "translations", `${chapterId}_zh.md`),
    stagingTranslationPath(ws.root, chapterId),
  ]) {
    const text = await readText(path);
    if (text === null) continue;
    const count = occurrences(text, oldZh).length;
    if (count === 0) return null;
    return { chapterId, paragraphId: "*", count, excerpt: excerptAround(text, oldZh) };
  }
  return null;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

// ===== 复查队列 =====

export interface RenameReviewEntry {
  id: string;
  ja: string;
  oldZh: string;
  newZh: string;
  chapterId: string;
  paragraphId: string;
  reason: RenameReviewReason;
  excerpt: string;
  createdAt: number;
  resolvedAt?: number;
}

export interface RenameReviewQueue {
  version: 1;
  entries: RenameReviewEntry[];
}

export function renameReviewPath(ws: Workspace): string {
  return join(ws.root, "state", "rename-review.json");
}

export async function readRenameReview(ws: Workspace): Promise<RenameReviewQueue> {
  const raw = await readJson<Partial<RenameReviewQueue>>(renameReviewPath(ws)).catch(() => null);
  const entries = Array.isArray(raw?.entries) ? raw.entries.filter((entry): entry is RenameReviewEntry => Boolean(entry) && typeof entry.id === "string") : [];
  return { version: 1, entries };
}

async function appendRenameReview(ws: Workspace, entries: RenameReviewEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const path = renameReviewPath(ws);
  await withFileMutationQueue(path, async () => {
    const queue = await readRenameReview(ws);
    // 同一处出现只留一条：反复改名不该在队列里堆出同一段落的一串条目
    const seen = new Set(queue.entries.filter((entry) => !entry.resolvedAt).map((entry) => `${entry.chapterId}|${entry.paragraphId}|${entry.oldZh}`));
    const fresh = entries.filter((entry) => !seen.has(`${entry.chapterId}|${entry.paragraphId}|${entry.oldZh}`));
    if (fresh.length === 0) return;
    await mkdir(join(ws.root, "state"), { recursive: true });
    await atomicWriteFile(path, `${JSON.stringify({ version: 1, entries: [...queue.entries, ...fresh] }, null, 2)}\n`);
  });
}

/** 作者处理完一条复查 → 标记已解决（条目保留，改了哪里要能回看） */
export async function resolveRenameReview(ws: Workspace, entryId: string): Promise<boolean> {
  const path = renameReviewPath(ws);
  return withFileMutationQueue(path, async () => {
    const queue = await readRenameReview(ws);
    const target = queue.entries.find((entry) => entry.id === entryId && !entry.resolvedAt);
    if (!target) return false;
    target.resolvedAt = Date.now();
    await atomicWriteFile(path, `${JSON.stringify(queue, null, 2)}\n`);
    return true;
  });
}

// ===== 落地 =====

/**
 * 执行计划：窄门内的段落逐段替换并打「复查」标记，窄门外的进复查队列。
 *
 * 打标记而不是静默改掉，是因为自动替换再窄也只是**确定性上说得通**，
 * 读起来通不通顺得作者说了算——尤其是改名后可能出现的重复称呼、语序别扭。
 */
export async function applyRenamePlan(ws: Workspace, plan: RenamePlan): Promise<RenameApplyResult> {
  const byChapter = new Map<string, Set<string>>();
  for (const hit of plan.auto) {
    const set = byChapter.get(hit.chapterId) ?? new Set<string>();
    set.add(hit.paragraphId);
    byChapter.set(hit.chapterId, set);
  }

  let replaced = 0;
  const chapters: string[] = [];
  const at = Date.now();
  for (const [chapterId, paragraphIds] of byChapter) {
    const file = await readChapterParagraphs(ws, chapterId);
    if (!file) continue;
    let touched = 0;
    const next = file.paragraphs.map((paragraph) => {
      if (!paragraphIds.has(paragraph.id) || !paragraph.translation.includes(plan.oldZh)) return paragraph;
      // 落地时按占位判定重算（TP-3）：计划与落地之间正文可能变了——
      // 位置失效或冒出咬合，宁可整段不动也不按过期计划硬替。
      const claims = claimOccurrences(paragraph.translation, plan.oldZh, plan.otherZh);
      if (claims.free.length === 0 || claims.contested.length > 0) return paragraph;
      touched += 1;
      return {
        ...paragraph,
        translation: replaceAtPositions(paragraph.translation, claims.free, plan.oldZh.length, plan.newZh),
        recheck: { reason: `追溯改名 ${plan.oldZh} → ${plan.newZh}`, at },
      } satisfies ChapterParagraph;
    });
    if (touched === 0) continue;
    // 定稿章节写 translations/，未定稿的写 staging——按现存文件判断，避免把
    // staging 稿提升成定稿，或反过来把定稿降级。
    const staging = !(await readText(join(ws.root, "translations", `${chapterId}_zh.md`)));
    await writeChapterParagraphs(ws, chapterId, next, { baseRevision: file.revision, staging });
    await syncDraft(ws, chapterId, next, paragraphIds);
    replaced += touched;
    chapters.push(chapterId);
  }

  const queued: RenameReviewEntry[] = plan.review.map((item, index) => ({
    id: `rn-${at}-${index}`,
    ja: plan.ja,
    oldZh: plan.oldZh,
    newZh: plan.newZh,
    chapterId: item.chapterId,
    paragraphId: item.paragraphId,
    reason: item.reason,
    excerpt: item.excerpt,
    createdAt: at,
  }));
  await appendRenameReview(ws, queued);

  return { replaced, chapters, queued: queued.length };
}

/**
 * 编辑器底稿（`state/drafts/{id}.json`）跟着改。
 *
 * 章节加载时底稿优先于译文文件——不同步的话，作者打开章节看到的还是旧译名，
 * 一保存又把旧译名写回译文，追溯改名等于白做。只改自动替换过的那些段落 id，
 * 人改保护段与底稿里的其他内容一个字不动。
 */
async function syncDraft(
  ws: Workspace,
  chapterId: string,
  paragraphs: ReadonlyArray<ChapterParagraph>,
  changed: ReadonlySet<string>,
): Promise<void> {
  const path = join(ws.root, "state", "drafts", `${chapterId}.json`);
  await withFileMutationQueue(path, async () => {
    const draft = await readJson<{ revision?: number; savedAt?: number; paragraphs?: Array<{ id: string; source: string; translation: string }> }>(path).catch(() => null);
    if (!draft || !Array.isArray(draft.paragraphs)) return;
    const byId = new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph.translation]));
    let touched = false;
    const next = draft.paragraphs.map((row) => {
      if (!changed.has(row.id)) return row;
      const translation = byId.get(row.id);
      if (translation === undefined || translation === row.translation) return row;
      touched = true;
      return { ...row, translation };
    });
    if (!touched) return;
    await atomicWriteFile(path, `${JSON.stringify({ ...draft, paragraphs: next }, null, 2)}\n`);
  });
}

/** 扫描 + 落地一次做完（IPC 层的常用形态） */
export async function retroRename(ws: Workspace, input: RenameInput): Promise<RenamePlan & RenameApplyResult> {
  const plan = await planRename(ws, input);
  const applied = await applyRenamePlan(ws, plan);
  // TP-4：改名事件入日志。正在飞行的章此刻还没落盘、这次扫描扫不到它——
  // 它落盘后按时间戳发现这条事件并对自己补扫。
  if (input.oldZh && input.newZh && input.oldZh !== input.newZh) {
    await appendRenameEvent(ws, { ja: input.ja, oldZh: input.oldZh, newZh: input.newZh, at: Date.now() });
  }
  return { ...plan, ...applied };
}
