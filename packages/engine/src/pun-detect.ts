/**
 * pun-detect —— 双关档案的防御清洗（EX-08 之后只剩这一件事）。
 *
 * 原来这里是**独立的谐音梗检测轮**：机械选取候选行 → 喂 LLM → 打捞候选 → 建卡。
 * 它属于译前提取链，随 ADR-0007 一起退役——梗的登记改由译者在翻译那次阅读里顺手完成
 * （融合提取），拿不准的由作者在术语面板手动登记（L4 地板）。
 *
 * 留下的 {@link cleanZhHint} 仍是活路径：旧数据里的 zhHint 可能是一整句建议
 * （「可以译成…」），原样注入译文会在正文里留下一对空括号或一句废话。
 */

export interface PunCandidate {
  ja: string;
  /** 出现上下文 */
  context: string;
  /** 梗的解释（供作者判断与译注） */
  note: string;
  /** 译法提示（可选） */
  zhHint?: string;
  confidence: number;
}

export function cleanZhHint(hint: string | undefined): string | undefined {
  if (!hint) return undefined;
  let h = hint.trim();
  h = h.replace(/^(可译作|可译为|建议译作|建议译为|译作|译为|可以译成)[「「]?/, "");
  // 优先在「」闭合处截断，其次句子标点，再限长
  const close = h.indexOf("」");
  if (close > 0) {
    h = h.slice(0, close + 1).replace(/」$/, "");
  } else {
    const boundary = h.search(/[，。！？!?]/);
    if (boundary > 0) h = h.slice(0, boundary);
  }
  if (h.length > 12) h = h.slice(0, 12);
  return h || undefined;
}
