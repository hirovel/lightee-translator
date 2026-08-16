/**
 * RV-04：问题定位从「字符串反解」改为「产出时记录」。
 *
 * 现状四种互不兼容的 location 格式里，四处是硬编码 `:1`——
 * 于是 resolveIssueParagraphIds 把它们统统解析成第一段，
 * 局部修订会去改一个跟问题毫无关系的段落。
 */
import { describe, expect, it } from "vitest";
import { resolveChecksRun, scanAllChapters, type ScanChapterInput } from "../src/reviewer-scan.ts";

const PARAS = [
  { id: "p0001", source: "夜だった。", translation: "已是夜里。" },
  { id: "p0002", source: "風が吹いた。", translation: "起风了。" },
  { id: "p0003", source: "桧山灯は黙っていた。", translation: "她一言不发。" },
  { id: "p0004", source: "それから桧山灯は歩き出した。", translation: "随后她迈步走了出去。" },
];

function chapter(paragraphs = PARAS): ScanChapterInput[] {
  return [{
    id: "ch001",
    source: paragraphs.map((p) => p.source).join("\n\n"),
    translation: paragraphs.map((p) => p.translation).join("\n\n"),
    paragraphs,
  }];
}

describe("RV-04 术语问题落在真正出问题的段落上", () => {
  // count_mismatch（术语出现次数不符）的定位用例随该检查一起删除：
  // 「原文两处专名、译文一处用代词」是合理译法，不是缺陷。

  it("dialogue_format 指向引号不配对的那一段", () => {
    const paras = [
      { id: "p0001", source: "「おはよう」", translation: "“早上好。”" },
      { id: "p0002", source: "「またね", translation: "“回头见。" },
    ];
    const issues = scanAllChapters(chapter(paras));
    const hit = issues.find((i) => i.type === "dialogue_format");
    expect(hit).toBeDefined();
    expect(hit!.paragraphIds).toEqual(["p0002"]);
  });

  it("pun_note_missing 指向译法所在的段落", () => {
    const paras = [
      { id: "p0001", source: "夜だった。", translation: "已是夜里。" },
      { id: "p0002", source: "灯ヒナと呼んだ。", translation: "他喊了一声小灯。" },
    ];
    const issues = scanAllChapters(chapter(paras), "zh", [{ ja: "灯ヒナ", zh: "小灯", note: "谐音" }]);
    const hit = issues.find((i) => i.type === "pun_note_missing");
    expect(hit).toBeDefined();
    expect(hit!.paragraphIds).toEqual(["p0002"]);
  });

  it("段落级检查的定位沿用段落 id（不退化为行号）", () => {
    const paras = [
      { id: "p0001", source: "夜だった。", translation: "已是夜里。" },
      { id: "p0002", source: "彼女はシルヴェストに会った。", translation: "她见到了シルヴェスト。" },
    ];
    const issues = scanAllChapters(chapter(paras));
    const hit = issues.find((i) => i.type === "kana_leftover");
    expect(hit).toBeDefined();
    expect(hit!.paragraphIds).toEqual(["p0002"]);
  });

  it("拿不到段落数据时不编造 paragraphIds", () => {
    // 按整章判定的检查在没有段落数据时照样报，但 paragraphIds 必须缺席——
    // 猜一个出来会让局部修订去改无辜段落。
    const issues = scanAllChapters(
      [{ id: "ch001", source: "「おはよう", translation: "“早上好" }],
    );
    const hit = issues.find((i) => i.type === "dialogue_format");
    expect(hit).toBeDefined();
    expect(hit!.paragraphIds).toBeUndefined();
  });
});

describe("RV-04 checksRun 是真话", () => {
  it("有段落数据时才跑段落级检查，没有时不声称跑过", () => {
    const withParas = resolveChecksRun({ puns: 0, noTranslate: 0, hasParagraphs: true });
    expect(withParas).toContain("kana_leftover");
    const without = resolveChecksRun({ puns: 0, noTranslate: 0, hasParagraphs: false });
    expect(without).not.toContain("kana_leftover");
  });

  it("术语一致性已不再是一项检查，绝不出现在清单里", () => {
    // 最后一条术语检查（count_mismatch）删除后，审校侧对词表一次都不查。
    // 还把 term_consistency 报进「N 项检查全部通过」，就是 RV-04 判过死刑的那种谎话。
    expect(resolveChecksRun({ puns: 0, noTranslate: 0, hasParagraphs: false })).not.toContain("term_consistency");
    expect(resolveChecksRun({ puns: 9, noTranslate: 9, hasParagraphs: true })).not.toContain("term_consistency");
  });

  it("恒定检查项无论输入都在", () => {
    expect(resolveChecksRun({ puns: 0, noTranslate: 0, hasParagraphs: false }))
      .toEqual(expect.arrayContaining(["dialogue_format", "quote_style_leftover", "untranslated", "kana_note"]));
  });
});
