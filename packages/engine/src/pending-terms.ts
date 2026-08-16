/**
 * pending-terms —— 译者在翻译途中标注的新术语候选。
 *
 * 术语预扫描按统计特征（片假名 / 类人名 / 高频）挑候选，它读不出语境；译者是在通读上下文时
 * 遇到这些词的，能发现预扫描漏掉的专名。此前提示词要求标注、却没有任何一处收割，标记只是
 * 留在译文里；标注格式又与所有消费方的正则不一致，连剥离都剥不掉——花了 token 却三头落空。
 *
 * 标记格式 `【待审:原文】` 是这里与提示词、term-adherence、reviewer-scan 共同的约定，
 * 改动必须同步四处。
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { atomicWriteJson } from "@lightee/core/atomic-fs";
import { buildCard } from "@lightee/core/evidence-card";
import { TerminologyRepository } from "@lightee/core/terminology-repository";
import { appendCards, loadSession } from "./confirm-session.ts";
import type { Workspace } from "./workspace.ts";

/** 与 term-adherence.ts / reviewer-scan.ts 的剥离正则同源 */
const PENDING_MARK = /【待审:([^】]+)】/g;

export interface PendingTerm {
  ja: string;
  /**
   * 标记所在的原句片段。**不从中切出译法**：译法紧邻标记之前，但中文没有词边界，
   * 贪婪取字会把动词一起吃进去（「他打开了道具箱」而不是「道具箱」）。
   * 切错边界的预填候选会被顺手接受，比留空更糟——把整句给用户，让人自己认。
   */
  context: string;
  chapterId: string;
  /**
   * 融合提取（EX-04）登记的译法。三条来源共用这一个队列：
   * 内联【待审:】标记、假名残留反推（R4-2）、融合尾块登记——前两条只知道原文形态，
   * 只有融合登记带着模型给出的译法。带 zh 的条目建卡时能预填候选，不带的留原文让作者自己认。
   */
  zh?: string;
  /** 融合登记给出的类型（person/place/org/title/item/world/other） */
  type?: string;
  /**
   * 模型给的一句话说明。对 pun 而言这**就是译注内容**——确认之后它进 puns.json 的 note，
   * 后续章节的双关档案块照着它往正文里印（译注: …）。
   *
   * 因此这里绝不允许由代码代填：一句关于软件自己的话（「译者在 ch001 登记的新术语」）
   * 一旦进了这个字段，读者会在正文里读到它。没有说明就留空。
   */
  note?: string;
}

/**
 * 取词在原文里的首现片段（前后各 30 字，与 {@link extractPendingTerms} 同一口径）。
 * 找不到就返回空串——凑一段不含这个词的上下文，比没有上下文更误导。
 */
export function firstOccurrence(source: string, ja: string): string {
  const at = source.indexOf(ja);
  if (at < 0) return "";
  return source.slice(Math.max(0, at - 30), at + ja.length + 30);
}

/** 从译文提取新术语标记。同一词只保留首次出现的上下文。 */
export function extractPendingTerms(translation: string, chapterId = ""): PendingTerm[] {
  const found = new Map<string, PendingTerm>();
  for (const match of translation.matchAll(PENDING_MARK)) {
    const ja = (match[1] ?? "").trim();
    if (!ja || found.has(ja)) continue;
    const at = match.index ?? 0;
    found.set(ja, {
      ja,
      context: translation.slice(Math.max(0, at - 30), at + match[0].length + 30),
      chapterId,
    });
  }
  return [...found.values()];
}

// ===== R4-2：从译文残留反推待审术语 =====
//
// 实测（本项目 2026-08-10，真实模型翻译一章 4622 字）：术语表外的 6 个角色名共出现 53 次，
// 模型写出的【待审:】标记 **0 个**。让模型主动标注是 L3 的活，而这件事 L1 就能做得更好——
// 译文里原样留着的日文词，本身就是「这个词我不知道该怎么处理」的确凿信号。
// 【待审:】保留为补充来源：它能报出已经译了、但译者仍觉得需要作者拍板的词。

/** 与 reviewer-scan 的 kana_leftover 同源：2 个以上连成词的假名 */
const KANA_WORD_RE = /[ァ-ヴー]{2,}|[ぁ-ん]{3,}/g;
/** 原文里的完整专名形态（含中点与长音） */
const KANA_RUN_RE = /[ァ-ヴー・]{2,}/g;
/** 译注括注里的假名是合法的（谐音梗要摆出日文读音） */
const NOTE_RE = /（\s*译\s*注?\s*[：:](?:[^（）]|（[^）]*）)*）|\(\s*译\s*注?\s*[：:](?:[^()]|\([^)]*\))*\)/g;

function bigrams(text: string): Set<string> {
  const clean = text.replace(/\s+/g, "");
  const out = new Set<string>();
  for (let i = 0; i + 2 <= clean.length; i++) out.add(clean.slice(i, i + 2));
  return out;
}

function overlap(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const g of x) if (y.has(g)) shared++;
  return shared / (x.size + y.size - shared);
}

/**
 * 从「原文段 / 译文段」对里收出泄漏到译文的日文专名。
 *
 * 取词时回到**原文**找包含它的完整假名串：译文里的正则会把「ピナ・ブランシュ」在中点处切开，
 * 拿半个名字去建候选，作者看到的就是个残件。
 */
export function collectLeakedTerms(
  pairs: ReadonlyArray<{ source: string; translation: string }>,
  noTranslate: ReadonlyArray<{ ja: string }>,
  chapterId = ""
): PendingTerm[] {
  const banned = noTranslate.map((entry) => entry.ja).filter(Boolean);
  const found = new Map<string, PendingTerm>();
  for (const pair of pairs) {
    const src = pair.source.trim();
    const tr = pair.translation.trim();
    if (!src || !tr) continue;
    // 整段原样返回是漏译，不是术语泄漏——那由 untranslated / source_echo 负责
    if (overlap(src, tr) >= 0.85) continue;
    const scanned = tr.replace(NOTE_RE, "");
    const runs = src.match(KANA_RUN_RE) ?? [];
    for (const word of new Set(scanned.match(KANA_WORD_RE) ?? [])) {
      if (banned.some((entry) => entry.includes(word))) continue;
      // 回到原文取完整形态；原文里找不到（模型自造）就用译文里的形态
      const full = runs.filter((run) => run.includes(word)).sort((a, b) => b.length - a.length)[0] ?? word;
      if (found.has(full)) continue;
      const at = scanned.indexOf(word);
      found.set(full, { ja: full, context: scanned.slice(Math.max(0, at - 30), at + word.length + 30), chapterId });
    }
  }
  return [...found.values()];
}

function pendingPath(ws: Workspace): string {
  return join(ws.root, "state", "pending-terms.json");
}

/**
 * 合并落盘。已在术语档案里的词不再登记——预扫描已经收过的词再报一遍只会让确认队列变长。
 * 返回本次真正新增的条目，供上层决定是否提示用户。
 */
export async function recordPendingTerms(
  ws: Workspace,
  terms: PendingTerm[],
  knownJa: ReadonlySet<string>,
): Promise<PendingTerm[]> {
  const fresh = terms.filter((term) => !knownJa.has(term.ja));
  if (fresh.length === 0) return [];

  const path = pendingPath(ws);
  const existing = await readPendingTerms(ws);
  const byJa = new Map(existing.map((term) => [term.ja, term]));
  const added: PendingTerm[] = [];
  for (const term of fresh) {
    if (byJa.has(term.ja)) continue;
    byJa.set(term.ja, term);
    added.push(term);
  }
  if (added.length === 0) return [];
  await atomicWriteJson(path, [...byJa.values()]);
  return added;
}

/**
 * 把待办候选送进术语确认队列。
 *
 * 时序上这些词产生在 prepareTerminology 之后（译者在翻译途中才遇到），赶不上那一轮的队列，
 * 因此需要一条独立的入队通道。落盘只是不丢，入队才让用户看得见。
 *
 * 入队前重查一次术语档案与当前队列：待办文件是跨轮累积的，期间用户可能已经确认过同名词。
 * 入队成功的条目从待办文件移除，避免下一轮重复入队。
 */
/**
 * 词条类型 → 决策卡类型，也就是**确认之后这条词落进哪个档案**
 * （`confirm-session.ts` 按卡片 type 路由：name→names、pun→puns、term→terms）。
 *
 * 从前这里是硬编码的 `"term"`，模型给的 type 只作为 `metadata.termType` 留个念想。
 * 后果有两条，2026-08-12 单章实测才照出来：
 *
 * - **人名永远进不了 `names.json`**，全都堆在 terms 里；
 * - **双关永远进不了 `puns.json`**，于是 `buildChapterPunBlock`（后续章节自动带译注）
 *   与 `pun_note_missing` 检查这两样，从工具通道过来的词一个都触发不了。
 *
 * 那一章的实证：模型把谐音昵称识别对了、译法也取对了，就是没加译注——而本该
 * 兜住这件事的检查，因为词根本进不了 puns 档案，结构上就不可能触发。
 *
 * 其余类型（place/org/title/item/world/other）合并进 terms：档案只有这三个出口，
 * 硬拆没有去处。宁可少分，不可分错。
 */
function cardTypeFor(type: string | undefined): "name" | "term" | "pun" {
  if (type === "person") return "name";
  if (type === "pun") return "pun";
  return "term";
}

export async function promotePendingTerms(ws: Workspace): Promise<{ added: number; sessionId?: string }> {
  const pending = await readPendingTerms(ws);
  if (pending.length === 0) return { added: 0 };

  const snapshot = await new TerminologyRepository(ws.root).readSnapshot();
  const archived = new Set(
    Object.values(snapshot.archives)
      .flat()
      .map((entry) => String((entry as { ja?: unknown }).ja ?? ""))
      .filter(Boolean)
  );
  const queued = new Set(((await loadSession(ws))?.cards ?? []).map((card) => card.ja));

  const fresh = pending.filter((term) => !archived.has(term.ja) && !queued.has(term.ja));
  if (fresh.length === 0) {
    // 全部已被别处收编：清掉待办，不建会话
    await atomicWriteJson(pendingPath(ws), []);
    return { added: 0 };
  }

  const cards = fresh.map((term) =>
    buildCard({
      ja: term.ja,
      type: cardTypeFor(term.type),
      context: term.context,
      // note 是**给读者看的译注内容**（pun 卡确认后进 puns.json，后续章节照着它往正文里印）。
      // 从前这里由代码现编一句「译者在 ch001 翻译本章时登记的新术语（pun）」——那是一句
      // 关于软件自己的话，模型给的真解释反倒被写进了 context。三个真实工作区的 puns.json
      // 里存的全是这句代填文本。没有说明就留空：空译注下游有明确含义（这个梗不需要译注），
      // 编一句出来则会被当成真的印出去。
      ...(term.note ? { note: term.note } : {}),
      metadata: { source: term.zh ? "fused" : "translator", chapterId: term.chapterId, ...(term.type ? { termType: term.type } : {}) },
      // 融合登记带着模型给出的译法，直接预填；内联标记只知道原文形态，候选就留原文
      // ——猜一个译法出来会被顺手接受，比留空更糟（与 pending-terms 的既有取舍一致）。
      // 两者置信度都低于预扫描候选：这是单章语境下的一次判断，未经全书统计与查证。
      candidates: [{ zh: term.zh || term.ja, confidence: term.zh ? 0.6 : 0.5, evidence: [] }],
    })
  );

  const session = await appendCards(ws, cards);
  const promoted = new Set(fresh.map((term) => term.ja));
  await atomicWriteJson(pendingPath(ws), pending.filter((term) => !promoted.has(term.ja)));
  return { added: cards.length, ...(session?.sessionId ? { sessionId: session.sessionId } : {}) };
}

export async function readPendingTerms(ws: Workspace): Promise<PendingTerm[]> {
  try {
    const parsed = JSON.parse(await readFile(pendingPath(ws), "utf-8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PendingTerm =>
      !!item && typeof item === "object" && typeof (item as PendingTerm).ja === "string"
    );
  } catch {
    return [];
  }
}
