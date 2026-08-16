/**
 * 段块切批算法 —— 确定性机械切割，无 LLM、无模糊规则。
 *
 * 原则：切割点永远是"段块边界"（空行/分隔符分隔的自然块），
 * 语义完整性由"段落是自然语义单元"保证。不追求语义场景边界。
 *
 * 切割优先级：
 *  a. 累积达到目标字数时正好在段块边界 → 切在这里
 *  b. 超过目标 → 回退到最近的段块边界切（宁少勿多）
 *  c. 单个段块就超目标（罕见超长段）→ 段内按句末/「」边界强制切
 *  d. 分隔符（***、─── 等）出现 → 优先在分隔符处切（作者标记的场景切换）
 */

/** 分隔符模式：独立一行，只含分隔符号 */
const SEPARATOR_RE = /^\s*(?:[*＊*]{3,}|[-─—]{3,}|~{3,}|・{5,}|[○◯]{3,})\s*$/;

/** 段落内切分点：句号/问号/感叹号/对话引号闭合后 */
const SENTENCE_BOUNDARY_RE = /[。！？!?」』）)]/;

export interface TextBlock {
  /** 原始文本（含尾部换行） */
  text: string;
  /** 在源文本中的起始偏移（字节/字符位置，用于锚点映射） */
  startOffset: number;
  /** 是否以分隔符结尾（作者场景标记） */
  endsWithSeparator: boolean;
  /** 估算 token 数（按字符数 / 2 粗略估算日文） */
  estTokens: number;
}

export interface Batch {
  blocks: TextBlock[];
  /** 本批字符数 */
  charCount: number;
  /** 本批估算 token */
  estTokens: number;
  /** 本批是否因"超长单段强制切"产生 */
  containsForcedSplit: boolean;
}

/** 把章节文本切成段块列表（空行/分隔符分隔） */
export function splitBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  // 按空行分隔（保留段落内结构）
  const rawBlocks = text.split(/\n\s*\n/);
  let offset = 0;
  for (const raw of rawBlocks) {
    const trimmed = raw.replace(/\n+$/, "");
    if (trimmed.trim().length === 0) {
      offset += raw.length + 2; // 粗略推进偏移
      continue;
    }
    const endsWithSeparator = SEPARATOR_RE.test(trimmed.trim());
    blocks.push({
      text: trimmed,
      startOffset: offset,
      endsWithSeparator,
      estTokens: Math.ceil(trimmed.length / 2),
    });
    offset += raw.length + 2;
  }
  return blocks;
}

/**
 * 把段块切成批，目标每批 batchChars 字符。
 * 返回批列表；返回空数组当输入无有效块。
 */
export function batchBlocks(blocks: TextBlock[], batchChars: number): Batch[] {
  if (blocks.length === 0 || batchChars <= 0) {
    return [];
  }
  const batches: Batch[] = [];
  let current: TextBlock[] = [];
  let currentChars = 0;
  let forcedInCurrent = false;

  const flush = () => {
    if (current.length > 0) {
      batches.push({
        blocks: current,
        charCount: currentChars,
        estTokens: current.reduce((sum, b) => sum + b.estTokens, 0),
        containsForcedSplit: forcedInCurrent,
      });
      current = [];
      currentChars = 0;
      forcedInCurrent = false;
    }
  };

  for (const block of blocks) {
    // 超长单段：段内强制切分
    if (block.text.length > batchChars) {
      // 先把当前积累的 flush 掉（保持顺序）
      flush();
      const pieces = splitOversizedBlock(block, batchChars);
      for (const piece of pieces) {
        current = [piece];
        currentChars = piece.text.length;
        forcedInCurrent = true;
        flush();
      }
      continue;
    }

    // 分隔符优先切：分隔符块自身成批边界
    if (block.endsWithSeparator) {
      flush();
      current = [block];
      currentChars = block.text.length;
      flush();
      continue;
    }

    if (currentChars + block.text.length > batchChars && current.length > 0) {
      flush(); // 回退到段块边界，宁少勿多
    }
    current.push(block);
    currentChars += block.text.length;
  }
  flush();
  return batches;
}

/** 超长单段的段内强制切：优先句末/对话引号闭合处，绝不切在句子中间 */
function splitOversizedBlock(block: TextBlock, maxChars: number): TextBlock[] {
  const pieces: TextBlock[] = [];
  let remaining = block.text;
  let baseOffset = block.startOffset;

  while (remaining.length > maxChars) {
    const cut = findSafeCut(remaining, maxChars);
    const pieceText = remaining.slice(0, cut);
    pieces.push({
      text: pieceText,
      startOffset: baseOffset,
      endsWithSeparator: false,
      estTokens: Math.ceil(pieceText.length / 2),
    });
    baseOffset += cut;
    remaining = remaining.slice(cut);
  }
  if (remaining.length > 0) {
    pieces.push({
      text: remaining,
      startOffset: baseOffset,
      endsWithSeparator: block.endsWithSeparator,
      estTokens: Math.ceil(remaining.length / 2),
    });
  }
  return pieces;
}

/**
 * 在不超过 maxChars 的前提下找安全切割点：
 * 1. 从 maxChars 往前找最近的句末边界（句号/感叹/引号闭合）
 * 2. 找不到则找最近的空白
 * 3. 再找不到就在 maxChars 处硬切（保证不无限循环）
 */
function findSafeCut(text: string, maxChars: number): number {
  const window = text.slice(0, maxChars);
  // 从末尾往前找句末边界
  for (let i = window.length - 1; i >= Math.max(0, window.length - 200); i--) {
    if (SENTENCE_BOUNDARY_RE.test(window[i] ?? "")) {
      return i + 1;
    }
  }
  // 句末边界没有 → 找最近空白
  const lastSpace = window.lastIndexOf(" ");
  const lastNewline = window.lastIndexOf("\n");
  const best = Math.max(lastSpace, lastNewline);
  if (best > 0) {
    return best + 1;
  }
  // 硬切
  return maxChars;
}
