/**
 * evidence-card 测试：决策卡（候选+证据）+ 作者裁决应用。
 */
import { describe, it, expect } from "vitest";
import { buildCard, applyVerdict, filterByVerdict, type DecisionCard } from "../src/evidence-card.ts";

const CARD: DecisionCard = {
  ja: "森村透",
  reading: "とおる",
  type: "name",
  context: "「森村透(とおる)は……」",
  candidates: [
    { zh: "森村透", confidence: 0.9, evidence: [{ source: "official", url: "https://official.example", snippet: "官方中文版译名" }] },
    { zh: "森村彻", confidence: 0.6, evidence: [{ source: "community", url: "https://bbs.example", snippet: "汉化组常用" }] },
  ],
};

describe("evidence-card", () => {
  it("buildCard：从候选+证据组装决策卡", () => {
    const card = buildCard({
      ja: "黒炎",
      type: "term",
      candidates: [{ zh: "黑炎", confidence: 0.8 }],
      context: "黒炎(ヘルファイア)が燃える",
    });
    expect(card.ja).toBe("黒炎");
    expect(card.type).toBe("term");
    expect(card.candidates[0]!.zh).toBe("黑炎");
  });

  it("applyVerdict accept：选定候选", () => {
    const verdict = applyVerdict(CARD, { action: "accept", chosenZh: "森村透" });
    expect(verdict.zh).toBe("森村透");
    expect(verdict.confidence).toBe(0.9);
  });

  it("applyVerdict modify：作者自定义译名（覆盖候选）", () => {
    const verdict = applyVerdict(CARD, { action: "modify", chosenZh: "森村透同学" });
    expect(verdict.zh).toBe("森村透同学");
    expect(verdict.confidence).toBe(1);
  });

  it("applyVerdict skip：跳过（不采用）", () => {
    const verdict = applyVerdict(CARD, { action: "skip" });
    expect(verdict).toBeNull();
  });

  it("filterByVerdict：一批卡片 → 采用的条目", () => {
    const cards: DecisionCard[] = [
      CARD,
      { ja: "アイテムボックス", type: "term", context: "…", candidates: [{ zh: "道具箱", confidence: 0.7 }] },
    ];
    const applied = filterByVerdict(cards, [
      { ja: "森村透", action: "accept", chosenZh: "森村透" },
      { ja: "アイテムボックス", action: "skip" },
    ]);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.ja).toBe("森村透");
    expect(applied[0]!.zh).toBe("森村透");
  });

  it("裁决缺失的卡片默认跳过（安全默认）", () => {
    const applied = filterByVerdict([CARD], []);
    expect(applied).toEqual([]);
  });
});
