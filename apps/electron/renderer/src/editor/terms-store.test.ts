import { describe, expect, it } from "vitest";
import { TermStore, seedDemoTerms } from "./terms-store";

describe("TermStore", () => {
  it("finds relevant terms by source or translation text and caps the list", () => {
    const store = new TermStore();
    store.seed(seedDemoTerms());

    const relevant = store.relevant(["他靠着天台的围栏", "他靠着天台的围栏"], 8);
    expect(relevant.map((term) => term.zh)).toEqual(["天台", "围栏"]);
  });

  it("falls back to chapter terms when nothing matches", () => {
    const store = new TermStore();
    store.seed(seedDemoTerms());
    const fallback = store.relevant(["完全无关的内容"], 3);
    expect(fallback).toHaveLength(3);
    expect(fallback[0]!.id).toBe("t0001");
  });

  it("searches, filters by type, and excludes deleted terms", () => {
    const store = new TermStore();
    store.seed(seedDemoTerms());

    expect(store.query({ search: "魔法" }).map((term) => term.id)).toEqual(["t0009", "t0010", "t0011"]);
    expect(store.query({ type: "地名" })).toHaveLength(3);
    expect(store.query({ pending: true })).toHaveLength(2);
    expect(store.query({})).toHaveLength(15);

    store.remove("t0001");
    expect(store.counts()).toMatchObject({ total: 14, deleted: 1 });
    expect(store.query({})).toHaveLength(14);
    expect(store.query({ includeDeleted: true })).toHaveLength(15);

    store.restore("t0001");
    expect(store.counts()).toMatchObject({ total: 15, deleted: 0 });
  });

  it("keeps the deleted term out of relevance until restored", () => {
    const store = new TermStore();
    store.seed(seedDemoTerms());
    store.remove("t0004");
    expect(store.relevant(["他靠着天台的围栏", "他靠着天台的围栏"], 8).map((term) => term.zh)).toEqual(["天台"]);
    store.restore("t0004");
    expect(store.relevant(["他靠着天台的围栏", "他靠着天台的围栏"], 8).map((term) => term.zh)).toEqual(["天台", "围栏"]);
  });

  it("preserves archive metadata and keeps read-only rows out of local mutations", () => {
    const store = new TermStore();
    store.seed([
      { id: "names:t1", bookId: "b001", ja: "アリス", zh: "爱丽丝", type: "person_name", displayType: "名称", archive: "names", readOnly: true, reading: "ありす" },
      { id: "t1", bookId: "b001", ja: "魔導具", zh: "魔导具", type: "item", displayType: "术语", archive: "terms", readOnly: false },
    ]);

    expect(store.query({ search: "ありす" })[0]).toMatchObject({ id: "names:t1", archive: "names", reading: "ありす" });
    expect(store.query({ type: "名称" })).toHaveLength(1);
    expect(store.query({ archive: "names" })).toHaveLength(1);
    expect(store.update("names:t1", { zh: "不应修改" })).toBeNull();
    expect(store.remove("names:t1")).toBe(false);
    expect(store.restore("names:t1")).toBe(false);
    expect(store.update("t1", { zh: "魔导器" })).toMatchObject({ id: "t1", zh: "魔导器", archive: "terms" });
  });

  it("handles thousands of terms without losing queries", () => {
    const store = new TermStore();
    store.loadMany(5000);
    expect(store.query({})).toHaveLength(5000);
    expect(store.query({ type: "魔法" })).toHaveLength(1250);
    expect(store.query({ search: "物品4999" })).toHaveLength(1);
    store.remove("t04999");
    expect(store.counts().total).toBe(4999);
  });
});
