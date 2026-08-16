/**
 * evidence-card —— 术语决策卡（候选 + 证据 + 作者裁决）。
 *
 * 设计（见 docs/lightee-wiki.md）:
 *   Terminologist 定名轮产出候选 → 知识查证（webLookup）附证据 →
 *   决策卡展示给作者 → 作者裁决（accept/modify/skip）→ 写术语表（冻结）。
 *   wenyi 是自动定名 + 事后 lint 硬校验；我们是事前作者裁决 + 证据链。
 */

// ===== 类型 =====
export type EvidenceSourceType = "official" | "community" | "machine" | "unknown";

export interface Evidence {
  /** 来源类型: official(官方译名) / community(社区/汉化组) / dictionary(词典) / web */
  source: string;
  url: string;
  snippet: string;
  /** 来源可信度标注（决策轮降权依据）: official > community > unknown > machine */
  sourceType?: EvidenceSourceType;
}

export interface TermCandidate {
  zh: string;
  confidence: number;
  evidence: Evidence[];
}

export interface DecisionCard {
  ja: string;
  /** 注音（如 あまね） */
  reading?: string;
  type: "name" | "term" | "onomatopoeia" | "voice" | "pun";
  /** 卡片交互类型: select=候选选择（默认）· confirm=真伪确认 */
  cardKind?: "select" | "confirm";
  /** 首现上下文（节选） */
  context?: string;
  /** 处理方案说明（confirm 卡: 译注内容等） */
  note?: string;
  metadata?: Record<string, unknown>;
  candidates: TermCandidate[];
}

export interface Verdict {
  ja: string;
  action: "accept" | "modify" | "skip";
  /** accept 的候选或 modify 的自定义译名 */
  chosenZh?: string;
  chosenCharacter?: string;
  note?: string;
}

export interface AppliedEntry {
  ja: string;
  metadata?: Record<string, unknown>;
  zh: string;
  type: string;
  reading?: string;
  context?: string;
  /** 处理方案说明（pun 卡: 译注内容） */
  note?: string;
  confidence: number;
  evidence: Evidence[];
}

// ===== 组装 =====
export interface BuildCardOptions {
  ja: string;
  reading?: string;
  type: "name" | "term" | "onomatopoeia" | "voice" | "pun";
  cardKind?: "select" | "confirm";
  context?: string;
  note?: string;
  metadata?: Record<string, unknown>;
  candidates: Array<{ zh: string; confidence: number; evidence?: Evidence[] }>;
}

export function buildCard(opts: BuildCardOptions): DecisionCard {
  return {
    ja: opts.ja,
    reading: opts.reading,
    type: opts.type,
    cardKind: opts.cardKind,
    context: opts.context,
    note: opts.note,
    metadata: opts.metadata,
    candidates: opts.candidates.map((c) => ({
      zh: c.zh,
      confidence: c.confidence,
      evidence: c.evidence ?? [],
    })),
  };
}

// ===== 裁决 =====
export function applyVerdict(card: DecisionCard, verdict: Verdict): AppliedEntry | null {
  if (verdict.action === "skip") return null;
  if (verdict.action === "modify" && verdict.chosenZh) {
    return {
      ...card.metadata,
      ...(card.type === "voice" && verdict.chosenCharacter ? { character: verdict.chosenCharacter } : {}),
      ja: card.ja,
      zh: verdict.chosenZh,
      type: card.type,
      reading: card.reading,
      context: card.context,
      note: card.note,
      confidence: 1, // 作者自定义 = 最高置信
      evidence: card.candidates.flatMap((c) => c.evidence),
    };
  }
  // accept
  const chosen = card.candidates.find((c) => c.zh === verdict.chosenZh) ?? card.candidates[0];
  if (!chosen) return null;
  return {
    ...card.metadata,
    ...(card.type === "voice" && verdict.chosenCharacter ? { character: verdict.chosenCharacter } : {}),
    ja: card.ja,
    zh: chosen.zh,
    type: card.type,
    reading: card.reading,
    context: card.context,
    note: card.note,
    confidence: chosen.confidence,
    evidence: chosen.evidence,
  };
}

/** 一批卡片 + 一批裁决 → 采用的条目（无裁决的卡片默认跳过，安全默认） */
export function filterByVerdict(cards: DecisionCard[], verdicts: Verdict[]): AppliedEntry[] {
  const byJa = new Map(verdicts.map((v) => [v.ja, v]));
  const applied: AppliedEntry[] = [];
  for (const card of cards) {
    const verdict = byJa.get(card.ja);
    if (!verdict) continue; // 未裁决 → 跳过（作者没确认的不进术语表）
    const entry = applyVerdict(card, verdict);
    if (entry) applied.push(entry);
  }
  return applied;
}
