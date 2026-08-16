export type TermType = "称呼" | "道具" | "魔法" | "地名" | "待审";
export type TermArchive = "names" | "terms" | "voice" | "onomatopoeia" | "puns";

export interface TermRecord {
  id: string;
  bookId: string;
  ja: string;
  zh: string;
  type: string;
  displayType?: string;
  archive?: TermArchive;
  archiveFile?: string;
  sourceId?: string;
  readOnly?: boolean;
  pending?: boolean;
  deletedAt?: number | null;
  [key: string]: unknown;
}

export interface TermQuery {
  search?: string;
  type?: string;
  archive?: TermArchive | "全部";
  includeDeleted?: boolean;
  deletedOnly?: boolean;
  pending?: boolean;
}

export class TermStore {
  private terms: TermRecord[] = [];

  seed(records: TermRecord[]): void {
    this.terms = records.map((record) => ({ deletedAt: null, ...record }));
  }

  loadMany(count: number, prefix = "t"): void {
    const records: TermRecord[] = Array.from({ length: count }, (_, index) => {
      const n = index + 1;
      return {
        id: `${prefix}${String(n).padStart(5, "0")}`,
        bookId: "b001",
        ja: `アイテム${n}`,
        zh: `物品${n}`,
        type: n % 4 === 0 ? "地名" : n % 3 === 0 ? "魔法" : n % 2 === 0 ? "道具" : "称呼",
      };
    });
    this.seed(records);
  }

  all(): TermRecord[] {
    return [...this.terms];
  }

  query(query: TermQuery = {}): TermRecord[] {
    const search = query.search?.trim().toLocaleLowerCase() ?? "";
    return this.terms.filter((term) => {
      const displayType = term.displayType ?? term.type;
      if (query.archive && query.archive !== "全部" && term.archive !== query.archive) return false;
      if (query.deletedOnly) return Boolean(term.deletedAt);
      if (!query.includeDeleted && term.deletedAt) return false;
      if (query.pending && !term.pending) return false;
      if (query.type && query.type !== "全部" && displayType !== query.type) return false;
      if (search && !JSON.stringify({ ...term, displayType }).toLocaleLowerCase().includes(search)) return false;
      return true;
    });
  }

  relevant(paragraphTexts: readonly string[], limit: number, bookId = "b001"): TermRecord[] {
    const combined = paragraphTexts.join(" ");
    const matched = this.terms.filter((term) => {
      if (term.deletedAt) return false;
      if (term.bookId !== bookId) return false;
      return combined.includes(term.ja) || combined.includes(term.zh);
    });
    if (matched.length) return matched.slice(0, limit);
    return this.terms.filter((term) => !term.deletedAt && term.bookId === bookId).slice(0, limit);
  }

  update(id: string, patch: Partial<Pick<TermRecord, "ja" | "zh" | "type">>): TermRecord | null {
    const term = this.terms.find((candidate) => candidate.id === id);
    if (!term || term.readOnly) return null;
    Object.assign(term, patch);
    return { ...term };
  }

  remove(id: string): boolean {
    const term = this.terms.find((candidate) => candidate.id === id);
    if (!term || term.readOnly || term.deletedAt) return false;
    term.deletedAt = Date.now();
    return true;
  }

  restore(id: string): boolean {
    const term = this.terms.find((candidate) => candidate.id === id);
    if (!term || term.readOnly || !term.deletedAt) return false;
    term.deletedAt = null;
    return true;
  }

  confirm(id: string): boolean {
    const term = this.terms.find((candidate) => candidate.id === id);
    if (!term || !term.pending) return false;
    term.pending = false;
    return true;
  }

  counts(): { total: number; deleted: number; pending: number } {
    return {
      total: this.terms.filter((term) => !term.deletedAt).length,
      deleted: this.terms.filter((term) => Boolean(term.deletedAt)).length,
      pending: this.terms.filter((term) => term.pending && !term.deletedAt).length,
    };
  }
}

/** 仅测试使用（terms-store.test / confirm-store.test 的夹具）。生产代码无调用方，
 *  构建时被摇树掉。词汇一律取自本仓库自撰的天台场景，不得引入任何真实作品的词汇簇。 */
export function seedDemoTerms(): TermRecord[] {
  return [
    { id: "t0001", bookId: "b001", ja: "森村透", zh: "森村透", type: "称呼" },
    { id: "t0002", bookId: "b001", ja: "桧山灯", zh: "桧山灯", type: "称呼" },
    { id: "t0003", bookId: "b001", ja: "屋上", zh: "天台", type: "地名" },
    { id: "t0004", bookId: "b001", ja: "フェンス", zh: "围栏", type: "道具" },
    { id: "t0005", bookId: "b001", ja: "給水塔", zh: "给水塔", type: "道具" },
    { id: "t0006", bookId: "b001", ja: "日直", zh: "值日", type: "道具", pending: true },
    { id: "t0007", bookId: "b001", ja: "黒板", zh: "黑板", type: "道具", pending: true },
    { id: "t0008", bookId: "b001", ja: "夕日", zh: "夕阳", type: "道具" },
    { id: "t0009", bookId: "b001", ja: "魔法少女", zh: "魔法少女", type: "魔法" },
    { id: "t0010", bookId: "b001", ja: "転生", zh: "转生", type: "魔法" },
    { id: "t0011", bookId: "b001", ja: "スキル", zh: "技能", type: "魔法" },
    { id: "t0012", bookId: "b001", ja: "異世界", zh: "异世界", type: "地名" },
    { id: "t0013", bookId: "b001", ja: "ダンジョン", zh: "地下城", type: "地名" },
    { id: "t0014", bookId: "b001", ja: "剣", zh: "剑", type: "道具" },
    { id: "t0015", bookId: "b001", ja: "鎧", zh: "铠甲", type: "道具" },
  ];
}
