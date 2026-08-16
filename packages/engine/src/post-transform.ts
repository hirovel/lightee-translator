/**
 * 译后处理（L0 确定性文本变换）—— R0-1 引号映射 + R1-1 译后管线。
 *
 * 归属依据（docs/design/architecture-roadmap.md §1）：标点风格是字符级双射，
 * 属于零成本 100% 兑现的 L0 层。写在 prompt 里实测被无视（SSR26 单章 85 处日式引号），
 * 因此引号约束从 prompt 下沉到这里，模型的注意力预算只留给文风与语气。
 *
 * 例外（已知并接受）：正文刻意引用的日式书名/招牌会被一并映射，
 * 禁翻表（R1-3）与译后字典提供逃生口。
 */

import { applyDictionary, type DictRule } from "./dictionary.ts";

export type QuoteStyle = "zh" | "jp";

/** 日式 → 中文的引号双射（外层/内层各一对，方向保持） */
const JP_TO_ZH: Record<string, string> = {
  "「": "“",
  "」": "”",
  "『": "‘",
  "』": "’",
};

const ZH_TO_JP: Record<string, string> = Object.fromEntries(
  Object.entries(JP_TO_ZH).map(([jp, zh]) => [zh, jp])
);

const QUOTE_MAPS: Record<QuoteStyle, Record<string, string>> = { zh: JP_TO_ZH, jp: ZH_TO_JP };

const QUOTE_RE: Record<QuoteStyle, RegExp> = {
  zh: /[「」『』]/g,
  jp: /[“”‘’]/g,
};

/**
 * 把文本里的异风格引号映射为目标风格。
 * 映射表只收录来源风格字符，目标风格字符不在表内，因此天然幂等；
 * 两个方向互为逆映射（zh 后接 jp 回到原文）。
 */
export function applyQuoteStyle(text: string, style: QuoteStyle): string {
  const map = QUOTE_MAPS[style];
  return text.replace(QUOTE_RE[style], (ch) => map[ch] ?? ch);
}

export interface PostTransformContext {
  quoteStyle: QuoteStyle;
  /** 作者译后字典（terminology 的 postDict 档案）；缺省为空表 */
  postDict?: readonly DictRule[];
}

/**
 * 译后管线（R1-1）：**引号映射 → 译后字典**，两处写入点（初译落盘、局部修订）共用这一个出口。
 *
 * 步序不可换：字典排在后面，作者才能用一条规则推翻引号映射的结果
 * （例如刻意保留某本书名的日式书名号）。反过来的话，引号映射会把字典刚写好的结果再改一遍，
 * 作者规则就成了摆设。管线内容以后再长，调用方也不必跟着改。
 */
export function applyPostTransforms(text: string, ctx: PostTransformContext): string {
  return applyDictionary(applyQuoteStyle(text, ctx.quoteStyle), ctx.postDict ?? []);
}

/**
 * 找出与目标风格相反的引号（审校兜底用）。
 * 后处理生效时结果恒为空；非空即证明译文没走过 {@link applyQuoteStyle}。
 */
export function findForeignQuotes(text: string, style: QuoteStyle): Array<{ char: string; index: number }> {
  const re = new RegExp(QUOTE_RE[style].source, "g");
  const hits: Array<{ char: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) hits.push({ char: m[0], index: m.index });
  return hits;
}
