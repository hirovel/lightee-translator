/**
 * 作者字典（L0 确定性文本变换）—— R1 三层字典的共用引擎。
 *
 * 归属依据（docs/design/architecture-roadmap.md §1）：查找替换是零成本 100% 兑现的约束，
 * 属最低层。写进 prompt 换来的是「大概率照做」，还要按全价买单——同一条规则每章重付一次。
 *
 * 三类档案共用这里的条目应用：
 * - preDict   译前字典：作用于发给模型的原文 wire（存储源文不动）
 * - postDict  译后字典：作用于落盘译文（引号映射之后）
 * - noTranslate 禁翻表：不是替换，而是注入恒等映射 + 审校侧存在性检查
 */

import type { TerminologyEntry } from "@lightee/core/terminology-repository";

/** 查找替换条目。type="regex" 时 find 按正则解释，缺省按字面量。 */
export interface DictRule {
  find: string;
  replace: string;
  type?: string;
  enabled?: boolean;
  /**
   * 人话说明（界面显示，不参与匹配）。
   *
   * 内置规则是两条正则，界面上只摆裸正则时作者无从判断它到底动了什么——
   * 实测误读成「把所有对话结尾都换成句号」。规则可停用可删，但前提是看得懂。
   */
  note?: string;
}

/** 禁翻条目：ja 是必须原样出现在译文里的源串。 */
export interface NoTranslateEntry {
  ja: string;
  note?: string;
  enabled?: boolean;
}

export interface Dictionaries {
  preDict: DictRule[];
  postDict: DictRule[];
  noTranslate: NoTranslateEntry[];
}

function usable(entry: { enabled?: boolean }): boolean {
  return entry.enabled !== false;
}

/**
 * 按条目序依次应用查找替换；后一条看得到前一条的结果。
 *
 * 字面量条目走 split/join：`String.replace(string, string)` 会把替换文本里的 `$&`/`$1`
 * 当成捕获引用，用户写的 `$` 会被静默吃掉。正则条目保留 `$1` 语义（捕获引用是用它的理由）。
 *
 * 非法正则跳过而不是抛出：一条手抖写坏的规则不该让整章翻译失败。
 * 注意这里不设正则执行超时（Node 无同步中断手段），灾难性回溯的规则会拖慢本章。
 */
export function applyDictionary(text: string, entries: readonly DictRule[]): string {
  let out = text;
  for (const entry of entries) {
    if (!entry.find || !usable(entry)) continue;
    if (entry.type === "regex") {
      let re: RegExp;
      try {
        // 旗标含 m：字典作用对象是逐段正文，段内可有软换行，`^$` 按行锚定才是作者
        // 写下这两个符号时的预期（"整行是一段引语"这类规则否则永远匹配不上）。
        re = new RegExp(entry.find, "gm");
      } catch {
        continue;
      }
      out = out.replace(re, entry.replace);
    } else {
      out = out.split(entry.find).join(entry.replace);
    }
  }
  return out;
}

/**
 * 译前规整：作用点是 wire 组装，不是存储源文。
 * 段落 id 与切段结构由存储源文决定，规整只改段内字符——否则门禁合并会对不上段。
 */
export function applyPreTransforms(text: string, entries: readonly DictRule[]): string {
  return applyDictionary(text, entries);
}

/**
 * 本章禁翻词的注入行（恒等映射）。
 *
 * 不走占位符替换（架构决策 R-c）：占位符会破坏模型看到的句子结构，
 * 让代词与语序判断失据，代价高于它解决的问题。恒等映射只是把「这个词别动」
 * 说进已有的术语表格式里，与其他术语共用同一段注入。
 */
export function buildNoTranslateLines(entries: readonly NoTranslateEntry[], src: string): string {
  return entries
    .filter((entry) => entry.ja && usable(entry) && src.includes(entry.ja))
    .map((entry) => `- ${entry.ja} → ${entry.ja}（禁译，原样保留）`)
    .join("\n");
}

function dictRows(rows: readonly TerminologyEntry[] | undefined): DictRule[] {
  return (rows ?? []).flatMap((row) => {
    const find = typeof row.find === "string" ? row.find : "";
    if (!find) return [];
    return [{
      find,
      replace: typeof row.replace === "string" ? row.replace : "",
      ...(typeof row.type === "string" ? { type: row.type } : {}),
      ...(typeof row.enabled === "boolean" ? { enabled: row.enabled } : {}),
    }];
  });
}

function noTranslateRows(rows: readonly TerminologyEntry[] | undefined): NoTranslateEntry[] {
  return (rows ?? []).flatMap((row) => {
    const ja = typeof row.ja === "string" ? row.ja : "";
    if (!ja) return [];
    return [{
      ja,
      ...(typeof row.note === "string" ? { note: row.note } : {}),
      ...(typeof row.enabled === "boolean" ? { enabled: row.enabled } : {}),
    }];
  });
}

/**
 * 从术语仓库快照读三类字典。
 * 档案缺失按空表处理：R1 之前建立的工作区快照里没有这三个键，读不到不等于出错。
 */
export function readDictionaries(archives: Partial<Record<string, TerminologyEntry[]>>): Dictionaries {
  return {
    preDict: dictRows(archives.preDict),
    postDict: dictRows(archives.postDict),
    noTranslate: noTranslateRows(archives.noTranslate),
  };
}
