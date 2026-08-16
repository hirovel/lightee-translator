import { describe, expect, it } from "vitest";
import { TermStore, seedDemoTerms } from "./terms-store";
import { ConfirmStore } from "./confirm-store";

describe("ConfirmStore", () => {
  it("builds one card per pending term with candidates and evidence", () => {
    const store = new TermStore();
    store.seed(seedDemoTerms());
    const confirm = new ConfirmStore(store);

    const cards = confirm.list();
    expect(cards).toHaveLength(2);
    expect(cards[0]!.termId).toBe("t0006");
    expect(cards[0]!.candidates).toEqual(["值日", "值日生", "当值"]);
    expect(cards[0]!.evidence.map((row) => row.source)).toEqual(["web", "dict", "culture"]);
    expect(cards[0]!.evidence.every((row) => row.url.startsWith("https://"))).toBe(true);
  });

  it("locates a card by term id and rebuilds after confirmation", () => {
    const store = new TermStore();
    store.seed(seedDemoTerms());
    const confirm = new ConfirmStore(store);

    expect(confirm.cardForTerm("t0007")?.ja).toBe("黒板");
    store.confirm("t0006");
    confirm.rebuild();
    expect(confirm.count()).toBe(1);
    expect(confirm.list()[0]!.termId).toBe("t0007");
    store.confirm("t0007");
    confirm.rebuild();
    expect(confirm.count()).toBe(0);
  });

  it("falls back to a single-candidate card for unknown pending terms", () => {
    const store = new TermStore();
    store.seed([{ id: "t9999", bookId: "b001", ja: "未知語", zh: "未知", type: "道具", pending: true }]);
    const confirm = new ConfirmStore(store);
    expect(confirm.list()[0]!.candidates).toEqual(["未知"]);
  });
});
