import type { TermStore } from "./terms-store.js";

export type EvidenceSource = "web" | "dict" | "culture";

export interface EvidenceRow {
  source: EvidenceSource;
  label: string;
  summary: string;
  url: string;
}

export interface ConfirmationCard {
  termId: string;
  ja: string;
  currentZh: string;
  candidates: string[];
  evidence: EvidenceRow[];
}

/** 仅测试使用：与 seedDemoTerms 的两条 pending（t0006 日直 / t0007 黒板）配套的候选与证据夹具 */
const SEEDED_EVIDENCE: Record<string, { candidates: string[]; evidence: EvidenceRow[] }> = {
  t0006: {
    candidates: ["值日", "值日生", "当值"],
    evidence: [
      { source: "web", label: "weblio 辞書", summary: "日直：その日の当番。学校で、教室の整頓などを受け持つ係。", url: "https://www.weblio.jp/content/日直" },
      { source: "dict", label: "大辞林", summary: "日中の当直。またその人。", url: "https://dictionary.goo.ne.jp/word/日直" },
      { source: "culture", label: "中文用语习惯", summary: "校园语境多用「值日」；「值日生」指人，「当值」偏正式。", url: "https://example.com/culture/日直" },
    ],
  },
  t0007: {
    candidates: ["黑板", "板书", "黑板板面"],
    evidence: [
      { source: "web", label: "weblio 辞書", summary: "黒板：チョークで文字などを書くための板。", url: "https://www.weblio.jp/content/黒板" },
      { source: "dict", label: "大辞林", summary: "塗料を塗った書写用の板。", url: "https://dictionary.goo.ne.jp/word/黒板" },
      { source: "culture", label: "中文用语习惯", summary: "指板子本身用「黑板」；「板书」指写上去的内容。", url: "https://example.com/culture/黒板" },
    ],
  },
};

export class ConfirmStore {
  private readonly termStore: TermStore;
  private cards: ConfirmationCard[] = [];

  constructor(termStore: TermStore) {
    this.termStore = termStore;
    this.rebuild();
  }

  /** Replace the in-memory cards with the canonical confirm session payload. */
  sync(cards: ConfirmationCard[]): void {
    this.cards = cards.map((card) => ({
      ...card,
      candidates: [...card.candidates],
      evidence: [...card.evidence],
    }));
  }

  rebuild(): void {
    this.cards = this.termStore.all()
      .filter((term) => term.pending && !term.deletedAt)
      .map((term) => {
        const seeded = SEEDED_EVIDENCE[term.id] ?? {
          candidates: [term.zh],
          evidence: [{ source: "dict", label: "词书", summary: `「${term.ja}」的候选释义。`, url: "https://example.com/dict" }],
        };
        return {
          termId: term.id,
          ja: term.ja,
          currentZh: term.zh,
          candidates: seeded.candidates,
          evidence: seeded.evidence,
        };
      });
  }

  list(): ConfirmationCard[] {
    return this.cards.map((card) => ({ ...card, candidates: [...card.candidates], evidence: [...card.evidence] }));
  }

  cardForTerm(termId: string): ConfirmationCard | undefined {
    return this.cards.find((card) => card.termId === termId);
  }

  count(): number {
    return this.cards.length;
  }
}
