/**
 * Reviewer L0/L1 扫描 —— 跨章术语一致性检查（代码，零 token）。
 *
 * 输入: 全部译文 + 术语表 + 原文
 * 输出: ScanIssue[]（含精确位置 文件:行 + 自动 evidence）
 *
 * 检查项（对应 docs/lightee-wiki.md 三层漏斗的 L0/L1）:
 *  - missing: 原文有术语，译文缺失（跨章版本，带位置）
 *  - drift: 译文出现相似但不同的词（编辑距离）
 *  - count_mismatch: 出现次数显著不符
 *  - dialogue_format: 「」配对完整性（D5 对话格式保护）
 *  - quote_style_leftover: 异风格引号残留（R0-1 译后处理的回归探测器）
 *  - no_translate_missing: 禁翻词被译掉（R1-3 禁翻表的审计侧）
 */

import { checkArchiveAdherence } from "@lightee/core/archive-registry";
import { findForeignQuotes } from "./post-transform.ts";
import type { NoTranslateEntry } from "./dictionary.ts";

export type ScanIssueType = "dialogue_format" | "untranslated" | "kana_note" | "pun_note_missing" | "quote_style_leftover" | "no_translate_missing" | "kana_leftover";

export interface ScanIssue {
  id: string;
  type: ScanIssueType;
  severity: "high" | "medium" | "low";
  chapterId: string;
  /** 人类可读的位置串（文件:行 或 文件:段落 id）。仅供展示，不再作为定位的权威。 */
  location: string;
  /**
   * 权威定位（RV-04）：这条问题实际落在哪些段落上，产出时直接记录。
   *
   * 从前定位靠从 location 字符串反解行号，而四类问题的 location 是硬编码 `:1`——
   * 反解结果永远是第一段，于是局部修订会去改一个跟问题毫无关系的段落。
   * 拿不到段落数据时留空，**绝不猜**：错位修订会原子覆盖无辜段落。
   */
  paragraphIds?: string[];
  termJa?: string;
  expected?: string;
  found?: string;
  srcCount?: number;
  trCount?: number;
  /** 证据链（L0/L1 代码层免费生成） */
  evidence: Array<{ source: string; context: string }>;
  /** 修订不得破坏对话引号（D5） */
  dialogueSafe: boolean;
}

export interface ScanChapterInput {
  id: string;
  source: string;
  translation: string;
  /**
   * 段落权威数据（state/paragraphs/{id}.json）。
   * 提供时才跑 R3-1 的五项段落级检查——它们全都需要「这一段的原文对这一段的译文」，
   * 拿整章字符串去比会把正常的语序调整误判成异常。
   */
  paragraphs?: ReadonlyArray<{ id: string; source: string; translation: string }>;
}

type ScanParagraphs = ScanChapterInput["paragraphs"];

/**
 * 按谓词挑出出问题的段落（RV-04）。没有段落数据就返回 undefined——
 * 让 ScanIssue 的 paragraphIds 保持缺席，而不是塞一个猜的值进去。
 */
function locateParagraphs(
  paragraphs: ScanParagraphs,
  predicate: (para: { id: string; source: string; translation: string }) => boolean,
): string[] | undefined {
  if (!paragraphs || paragraphs.length === 0) return undefined;
  const hits = paragraphs.filter(predicate).map((p) => p.id);
  return hits.length > 0 ? hits : undefined;
}

/**
 * 位置展示串：有段落就报段落 id（可跳转），否则退回行号，两者都没有就只报文件名。
 *
 * `line` 必须是**真的定位到的**行号。传 null 表示没定位到——此时绝不能凑一个 `:1`：
 * `resolveIssueParagraphIds` 会把它当真，解析成第一段，局部修订随即去改一个与问题
 * 无关的段落。只报文件名时反解得到空数组，下游按兵不动，这才是诚实的降级。
 */
function locationFor(chapterId: string, file: "zh" | "src", paragraphIds: string[] | undefined, line: number | null): string {
  const name = file === "zh" ? `${chapterId}_zh.md` : `${chapterId}.md`;
  if (paragraphIds && paragraphIds[0]) return `${name}:${paragraphIds[0]}`;
  return line === null ? name : `${name}:${line}`;
}

/** 审校检查项的稳定 id（UI 的「N 项检查全部通过」清单靠它，必须与实际执行一致）。 */
export const CHECK_LABELS: Record<string, string> = {
  dialogue_format: "对话引号配对",
  quote_style_leftover: "引号风格残留",
  untranslated: "整段未译",
  // 「残留」是判决词，而这一条判不出对错：译文里的假名括注既可能是原文没删干净，
  // 也可能是译者有意给读者标读音（作者实测遇到的正是后者）。中性命名 + low 严重度，
  // 把裁定权留给作者——软件只负责把位置指出来。
  kana_note: "假名注音",
  no_translate: "禁翻词保留",
  pun_note: "谐音梗译注",
  kana_leftover: "残留假名",
};

/** 与输入无关、每次都跑的检查。 */
const ALWAYS_RUN = ["dialogue_format", "quote_style_leftover", "untranslated", "kana_note"] as const;
/** 只有拿得到段落权威数据才跑的检查（R4-1；R3-1 的五项启发式已在 CHK-02 删除）。 */
const PARAGRAPH_CHECKS = ["kana_leftover"] as const;

/**
 * 本次实际执行了哪些检查（RV-04）。
 *
 * 「N 项检查全部通过」若把没跑的也算进去就是谎话，所以这里按**前提是否满足**判定：
 * 没有禁翻词 → 禁翻检查没跑；没有段落数据 → 段落级检查没跑。
 *
 * `term_consistency` 已随最后一条术语检查（count_mismatch）一起移除：
 * 术语一致性现在由**注入**兑现（词表进静态前缀），审校侧一条都不再扫。
 */
export function resolveChecksRun(input: {
  puns: number;
  noTranslate: number;
  hasParagraphs: boolean;
}): string[] {
  const checks: string[] = [];
  checks.push(...ALWAYS_RUN);
  if (input.noTranslate > 0) checks.push("no_translate");
  if (input.puns > 0) checks.push("pun_note");
  if (input.hasParagraphs) checks.push(...PARAGRAPH_CHECKS);
  return checks;
}

/** 归一化（全角→半角） */
function normalize(s: string): string {
  return s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 行号定位：找内容在译文中的行 */
function locateLine(text: string, content: string): number | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(content)) return i + 1;
  }
  // 归一化再找
  const norm = normalize(text);
  const normLines = norm.split("\n");
  for (let i = 0; i < normLines.length; i++) {
    if (normLines[i]!.includes(normalize(content))) return i + 1;
  }
  // 找不到就说找不到。从前返回 0、调用方一律 `|| 1`，把「没找到」写成了「第 1 行」。
  return null;
}

// ===== 段落级机械检查（R3-1 → CHK-02）=====
//
// R3-1 曾在这里放六项按段判定的启发式检查。CHK-02 删掉其中五项
// （length_anomaly / repetition / source_echo / number_missing / line_count_mismatch）：
// 它们是为「模型不可靠」的年代设计的 harness，而实测的代价是误判——KA-4 验收里
// ch002 整章正确译文被 7 条假阳性按死：source_echo 把原样保留的 URL 判成未翻，
// number_missing 把「一番」「一方的」的「一」判成漏译数字。
//
// 留下的只有 kana_leftover：它判的是**结构事实**——中文译文里出现连续假名，
// 不需要任何关于「译得好不好」的猜测。

/** 字符双元组 Jaccard 到这个值即认定译文就是原文（kana_leftover 借它排除整段原样返回） */
const ECHO_JACCARD = 0.85;

function charBigrams(text: string): Set<string> {
  const clean = text.replace(/\s+/g, "");
  const grams = new Set<string>();
  for (let i = 0; i + 2 <= clean.length; i++) grams.add(clean.slice(i, i + 2));
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * 残留假名词的最短长度（R4-1）。
 *
 * 单个假名多半是拟声词或语气词的中文化残留，那是另一类问题；
 * 2 个以上连成词的假名出现在中文译文里，基本只有一种解释：这个专名没被翻译。
 * 实测一次真实翻译把 6 个未登记角色名共 53 处原样留下（244 个片假名字符），
 * 而按整行假名比例判定的 untranslated 一条都没报——一个名字混在中文句里到不了阈值。
 */
const KANA_LEFTOVER_MIN = 2;
/**
 * 译注括注里的假名是**合法的**：谐音梗的译注就是要把日文读音摆出来
 * （例：「（译：桧山灯（ひやま あかり）与灯ヒナ同音）」）。
 * 扫描前先剥掉这类括注，否则唯一一处正当用法会成为唯一一处误报。
 */
// 括注内部还会再套一层括号（「（译：桧山灯（ひやま あかり）和灯ヒナ（小灯）同音）」），
// 所以不能用 [^）]* —— 那会停在第一个内层右括号上，把后半段假名漏出来。
const TRANSLATOR_NOTE_RE = /（\s*译\s*注?\s*[：:](?:[^（）]|（[^）]*）)*）|\(\s*译\s*注?\s*[：:](?:[^()]|\([^)]*\))*\)/g;
const KANA_WORD_RE = /[ァ-ヴー]{2,}|[ぁ-ん]{3,}/g;

interface ParagraphIssueDraft {
  type: ScanIssueType;
  severity: ScanIssue["severity"];
  found?: string;
  expected?: string;
  note: string;
}

/** 单段检查。返回草稿，由调用方补 id/位置/证据。 */
function scanParagraph(
  source: string,
  translation: string,
  noTranslate: ReadonlySet<string> = new Set()
): ParagraphIssueDraft[] {
  const drafts: ParagraphIssueDraft[] = [];
  const src = source.trim();
  const tr = translation.trim();
  // 空译文交给既有的 untranslated / 门禁负责，这里报只会重复计数
  if (!src || !tr) return drafts;

  // 残留假名（R4-1）：中文句子里夹着没译的日文专名。
  // 判据用「与原文的重合度」而不是假名占比：短段落里一两个片假名人名就能把占比顶过任何阈值，
  // 恰恰把最该报的情形挡在门外。整段原样返回归 untranslated 管，这里只管句中夹着的日文词。
  const echoScore = jaccard(charBigrams(src), charBigrams(tr));
  if (echoScore < ECHO_JACCARD) {
    const scanned = tr.replace(TRANSLATOR_NOTE_RE, "");
    const words = [...new Set((scanned.match(KANA_WORD_RE) ?? []).filter((w) => w.length >= KANA_LEFTOVER_MIN))]
      // 作者要求原样保留的词不算残留；判定用「禁翻词包含这个假名串」，
      // 因为禁翻条目可能带汉字（「魔導スキル」），而这里切出来的只有假名部分。
      .filter((word) => ![...noTranslate].some((entry) => entry.includes(word)));
    if (words.length > 0) {
      drafts.push({
        type: "kana_leftover",
        severity: "medium",
        found: words.slice(0, 8).join("、"),
        note: "译文里留着未翻译的日文词，多半是术语表外的专名",
      });
    }
  }

  return drafts;
}

/** 跨章扫描全部章节 */
export function scanAllChapters(
  chapters: ScanChapterInput[],
  quoteStyle: "zh" | "jp" = "zh",
  /** 已确认谐音梗（D4: 译注存在性检查） */
  puns: Array<{ ja: string; zh?: string; note?: string }> = [],
  /** 追加输入按选项对象接（位置参数已经排到第 4 个，再加就没人数得清顺序了） */
  options: { noTranslate?: readonly NoTranslateEntry[] } = {}
): ScanIssue[] {
  const noTranslate = (options.noTranslate ?? []).filter((entry) => entry.ja && entry.enabled !== false);
  const issues: ScanIssue[] = [];
  let seq = 0;

  for (const ch of chapters) {
    const cleanTr = ch.translation.replace(/【待审:[^】]+】/g, "");

    // —— 术语检查已整族删除，`terms` 入参随之从签名上消失 ——
    //
    // CHK-02 删掉 term_missing / term_drift，本轮删掉最后一条 count_mismatch
    // （原文出现 N 次、译文只落下 M 次）。三条是同一族、同一个失败模式：
    // **代词化与省略都是合理译法**。原文三处专名、译文两处用「她」，是译得好，不是缺陷。
    //
    // 术语一致性的着力点在**上游**：累积词表冻结进静态前缀，模型翻的时候就看得见
    // （EX-05 追加序 + R2-1 前缀缓存）。事后拿正则数出现次数，测的从来不是一致性。
    //
    // 注意别与 `core/paragraph.ts` 的 `count_mismatch` 搞混：那个是**段落数不符**，
    // 是 L0 硬门禁，判的是结构事实，与本族无关，保留。
    //
    // `term_consistency` 也一并从 `resolveChecksRun` 移除：最后一条术语检查没了，
    // 再把它算进「N 项检查全部通过」就是 RV-04 判过死刑的那种谎话。

    // —— 对话格式检查（D5: 引号配对完整性，按 quoteStyle）——
    const [openQ, closeQ] = quoteStyle === "jp" ? ["「", "」"] : ["“", "”"];
    const openCount = (ch.translation.match(new RegExp(openQ.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
    const closeCount = (ch.translation.match(new RegExp(closeQ.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
    if (openCount !== closeCount) {
      // 整章数量对不上，但真正坏掉的通常是某一段。逐段自查，指向自身就不配对的那些；
      // 全段自查都配对（缺口跨段）时留空，不硬凑一个段落 id。
      const brokenParas = locateParagraphs(ch.paragraphs, (p) => {
        const opens = p.translation.split(openQ).length - 1;
        const closes = p.translation.split(closeQ).length - 1;
        return opens !== closes;
      });
      issues.push({
        id: `iss_${String(++seq).padStart(3, "0")}`,
        type: "dialogue_format",
        severity: "high",
        chapterId: ch.id,
        location: locationFor(ch.id, "zh", brokenParas, null),
        ...(brokenParas ? { paragraphIds: brokenParas } : {}),
        expected: `${openQ}${closeQ} 配对`,
        found: `${openQ}×${openCount} ${closeQ}×${closeCount}`,
        evidence: [{ source: `${ch.id}_zh.md`, context: `${openQ}${openCount} 个 vs ${closeQ}${closeCount} 个` }],
        dialogueSafe: false, // 修复时禁止机械替换（需人工）
      });
    }

    // —— 异风格引号残留（R0-1 后处理的回归探测器）——
    // 引号规整由 L0 的 applyQuoteStyle 兑现，后处理生效时本项恒为 0；
    // 非 0 说明这一章的译文没走过后处理。severity 取 medium：问题可见，
    // 但不进 high 熔断通道——确定性变换不该靠整章重译去修。
    const foreignQuotes = findForeignQuotes(ch.translation, quoteStyle);
    if (foreignQuotes.length > 0) {
      const first = foreignQuotes[0]!;
      const line = ch.translation.slice(0, first.index).split("\n").length;
      const chars = [...new Set(foreignQuotes.map((q) => q.char))].join("");
      const quoteChars = new Set(foreignQuotes.map((q) => q.char));
      const quoteParas = locateParagraphs(ch.paragraphs, (p) => [...quoteChars].some((c) => p.translation.includes(c)));
      issues.push({
        id: `iss_${String(++seq).padStart(3, "0")}`,
        type: "quote_style_leftover",
        severity: "medium",
        chapterId: ch.id,
        location: locationFor(ch.id, "zh", quoteParas, line),
        ...(quoteParas ? { paragraphIds: quoteParas } : {}),
        expected: quoteStyle === "jp" ? "「」『』" : "“”‘’",
        found: `${chars}×${foreignQuotes.length}`,
        evidence: [
          {
            source: `${ch.id}_zh.md:${line}`,
            context: ch.translation.split("\n")[line - 1]?.slice(0, 60) ?? "",
          },
        ],
        dialogueSafe: false, // 引号由后处理修，不走机械替换/重译通道
      });
    }

    // —— R3-1 段落级五项检查（只在拿得到段落权威数据时跑）——
    for (const para of ch.paragraphs ?? []) {
      for (const draft of scanParagraph(para.source, para.translation, new Set(noTranslate.map((e) => e.ja)))) {
        issues.push({
          id: `iss_${String(++seq).padStart(3, "0")}`,
          type: draft.type,
          severity: draft.severity,
          chapterId: ch.id,
          location: `${ch.id}_zh.md:${para.id}`,
          paragraphIds: [para.id],
          ...(draft.expected ? { expected: draft.expected } : {}),
          ...(draft.found ? { found: draft.found } : {}),
          evidence: [
            { source: `${ch.id}.md:${para.id}`, context: para.source.slice(0, 60) },
            { source: `${ch.id}_zh.md:${para.id}`, context: draft.note },
          ],
          // 这五项都是「这一段整体不对」，没有可机械替换的串
          dialogueSafe: false,
        });
      }
    }

    // —— 禁翻词存留（R1-3 禁翻表的审计侧）——
    // 注入侧只是「请你别动这个词」，兑现与否要有人查。判据用 cleanTr：
    // 禁翻词只出现在【待审:原文】标记里不算保留，那个标记会在落盘投影里被剥掉。
    for (const entry of noTranslate) {
      if (!ch.source.includes(entry.ja) || cleanTr.includes(entry.ja)) continue;
      // 词被译掉了，译文里找不到它——只能靠原文定位。
      const keptParas = locateParagraphs(ch.paragraphs, (p) => p.source.includes(entry.ja));
      issues.push({
        id: `iss_${String(++seq).padStart(3, "0")}`,
        type: "no_translate_missing",
        severity: "high",
        chapterId: ch.id,
        location: locationFor(ch.id, "src", keptParas, locateLine(ch.source, entry.ja)),
        ...(keptParas ? { paragraphIds: keptParas } : {}),
        termJa: entry.ja,
        expected: entry.ja,
        evidence: [
          { source: "terminology/no-translate.json", context: `${entry.ja}（禁译${entry.note ? `：${entry.note}` : ""}）` },
          { source: `${ch.id}.md`, context: ch.source.split("\n").find((l) => l.includes(entry.ja))?.slice(0, 60) ?? "" },
        ],
        // 机械替换需要「把什么换成什么」，而禁翻词被译成了什么无从得知——
        // 定位不到被替换的串，replace_all 只会改错地方。交给局部修订/人工。
        dialogueSafe: false,
      });
    }

    // —— 二次保证 1: 整段未译（日文残留比例高）——
    for (const [idx, line] of cleanTr.split("\n").entries()) {
      const t = line.trim();
      if (t.length < 6) continue; // 短行（标题/空行）跳过
      // 日文特征: 假名占比（汉字中日共有，用假名判定更准）
      const kana = t.match(/[぀-ヿ]/g) ?? [];
      const kanaRatio = kana.length / t.length;
      if (kanaRatio > 0.35) {
        const echoParas = locateParagraphs(ch.paragraphs, (p) => p.translation.includes(t));
        issues.push({
          id: `iss_${String(++seq).padStart(3, "0")}`,
          type: "untranslated",
          severity: "high",
          chapterId: ch.id,
          location: locationFor(ch.id, "zh", echoParas, idx + 1),
          ...(echoParas ? { paragraphIds: echoParas } : {}),
          found: t.slice(0, 40),
          evidence: [{ source: `${ch.id}_zh.md:${idx + 1}`, context: t.slice(0, 60) }],
          dialogueSafe: true,
        });
      }
    }

    // —— 二次保证 2: 假名注音（平假名括号）——
    // 双重阅读（片假名/拉丁括注）是合法表达，不检测。
    //
    // 这一条**判不出对错**：同一个形状既可能是原文注音没删干净，也可能是译者有意
    // 保留读音给读者看（作者实测遇到的正是后者）。所以它以 low 报出、命名中性，
    // 裁定权归作者——把有意的表达标成「残留」，是软件在下一个它没有依据下的判决。
    const RUBY_LEFT_RE = /[（(][\u3040-\u309f]{2,8}[）)]/g;
    let rm: RegExpExecArray | null;
    while ((rm = RUBY_LEFT_RE.exec(ch.translation)) !== null) {
      const lineIdx = ch.translation.slice(0, rm.index).split("\n").length;
      const rubyText = rm[0];
      const rubyParas = locateParagraphs(ch.paragraphs, (p) => p.translation.includes(rubyText));
      issues.push({
        id: `iss_${String(++seq).padStart(3, "0")}`,
        type: "kana_note",
        severity: "low",
        chapterId: ch.id,
        location: locationFor(ch.id, "zh", rubyParas, lineIdx),
        ...(rubyParas ? { paragraphIds: rubyParas } : {}),
        found: rubyText,
        evidence: [{ source: `${ch.id}_zh.md:${lineIdx}`, context: rm[0] }],
        dialogueSafe: true,
      });
    }

    // —— 二次保证 3: 谐音梗译注存在性（确认过的梗必须带译注）——
    // 统一走注册表 checkArchiveAdherence（D4 审校层的唯一实现）
    for (const pun of puns) {
      if (!pun.zh) continue;
      // 译注留空 = 作者判定这个梗不需要译注。界面上一直这么承诺
      //（「把术语表里的译注留空，这条就不再出现」），而这里从来没读过 note，
      // 于是作者照做之后条目纹丝不动——软件说了一件它没做的事。
      if (!pun.note?.trim()) continue;
      // 只查**这一章真的出现过**的梗：原文里有梗词，或译文里已经用上了它的译法。
      //
      // 从前没有这道门，于是任何一条「有译法、缺译注」的梗会在**每一章**都报一遍——
      // 作者在第 1 章登记的梗，第 2 章、第 3 章…全跟着报，而那些章里根本没有它
      // （实测：ch002 报出两条 pun_note_missing，两条都定位不到段落）。
      // 症状还有第二层：梗不在本章 → locateParagraphs 找不到任何段落 → location 退化成
      // 一个光秃秃的文件名，界面上既没有可点的「定位」，显示的也是另一码事。
      // 隔壁禁翻词检查一直有这道门（`!ch.source.includes(entry.ja)`），这里漏了。
      if (!ch.source.includes(pun.ja) && !cleanTr.includes(pun.zh)) continue;
      const ok = checkArchiveAdherence("puns", cleanTr, pun);
      if (ok) continue;
      const hasZh = cleanTr.includes(pun.zh);
      // 译法已经在译文里 → 缺的是译注，定位到译法所在段；译法还没出现 → 定位到原文含梗词的段。
      const punParas = hasZh
        ? locateParagraphs(ch.paragraphs, (p) => p.translation.includes(pun.zh!))
        : locateParagraphs(ch.paragraphs, (p) => p.source.includes(pun.ja));
      issues.push({
        id: `iss_${String(++seq).padStart(3, "0")}`,
        type: "pun_note_missing",
        severity: hasZh ? "low" : "medium",
        chapterId: ch.id,
        location: locationFor(ch.id, hasZh ? "zh" : "src", punParas, null),
        // 空数组是真值——`punParas ? …` 会把「一个段落都没定位到」写成 `paragraphIds: []`，
        // 下游还得再判一次长度。定位不到就不写这个字段。
        ...(punParas && punParas.length > 0 ? { paragraphIds: punParas } : {}),
        termJa: pun.ja,
        expected: pun.zh,
        found: hasZh ? "译法有但译注缺失" : "（译注: ...）缺失",
        evidence: [
          { source: "terminology/puns.json", context: `${pun.ja} → ${pun.zh}（需译注）` },
          { source: `${ch.id}_zh.md`, context: hasZh ? "未发现（译注: 标记" : `译法「${pun.zh}」未出现` },
        ],
        dialogueSafe: true,
      });
    }
  }

  return issues;
}
