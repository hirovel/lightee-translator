/**
 * compaction —— 上下文压缩（参考 pi-agent-core 的 compaction 机制）。
 *
 * pi 三件套（源码参考）:
 *   shouldCompact:  contextTokens > contextWindow - reserveTokens 触发
 *   findCutPoint:   保留最近 keepRecentTokens，之前的全部进摘要
 *   generateSummary: LLM 生成结构化 checkpoint 摘要（另一 LLM 可续作）
 * 用途: Manager（管理者 Agent）上下文随进度累积 → 超阈值压缩。
 */

// ===== 类型 =====
export interface CompactionSettings {
  enabled: boolean;
  /** 触发阈值 = 窗口 - reserveTokens */
  reserveTokens: number;
  /** 保留最近的 token 数（不压缩） */
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

export interface TokenEntry {
  tokens: number;
}

// ===== 触发 =====
export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings = DEFAULT_COMPACTION
): boolean {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}

// ===== 切点 =====
/** 从 start 开始累积，保留最近 keepRecentTokens，返回压缩起点（之前的进摘要） */
export function findCutPoint(
  entries: TokenEntry[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number
): number {
  let accumulated = 0;
  for (let i = endIndex - 1; i >= startIndex; i--) {
    accumulated += entries[i]?.tokens ?? 0;
    if (accumulated >= keepRecentTokens) {
      return i;
    }
  }
  return startIndex;
}

// ===== 摘要 =====
export interface SummaryMessage {
  role: string;
  content: string;
}

const SUMMARY_PROMPT = `You are Lightee's Manager session compactor. Compress the call records into a structured context checkpoint summary that a later Manager decision (plan/arbitrate/stuck) can use directly.

Must include:
- Task description (book / volume / target)
- Execution plan (current progress)
- Call records (chapter → status/result, incl. revision count and review summary)
- Progress state (stage of each chapter)
- File indexes (paths, not contents)

Must NOT include: translation full text, source full text, dialogue details.

Keep it factual and compact (~2048 tokens). Output a structured checklist so later decisions do not depend on the raw records.`;

export function buildSummaryMessages(
  entries: SummaryMessage[],
  previousSummary: string
): SummaryMessage[] {
  return [
    { role: "system", content: SUMMARY_PROMPT },
    ...(previousSummary ? [{ role: "user", content: `前次摘要:\n${previousSummary}` }] : []),
    ...entries,
    { role: "user", content: "Output the structured checkpoint summary (task/plan/call records/progress/file indexes; without translation or source full text)." },
  ];
}

export type CompleteFn = (system: string, user: string) => Promise<string>;

/** 生成压缩摘要（失败返回空串，不阻断——调用方保留原上下文继续） */
export async function generateSummary(
  complete: CompleteFn,
  entries: SummaryMessage[],
  previousSummary: string
): Promise<string> {
  const messages = buildSummaryMessages(entries, previousSummary);
  try {
    const raw = await complete(SUMMARY_PROMPT, messages.map((m) => m.content).join("\n\n"));
    return raw.trim();
  } catch {
    return "";
  }
}
