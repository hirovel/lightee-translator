import { describe, expect, it } from "vitest";
import { scanAllChapters } from "../src/reviewer-scan.js";

// 术语族检查（term_missing / term_drift / count_mismatch）已整族删除，`terms` 入参
// 也从签名上消失，所以这里不再有词表夹具。删除判据是同一条：**代词化与省略是合理译法**，
// 拿正则数译文里出现几次，测的从来不是一致性。一致性由翻译时的词表注入兑现。

describe("Reviewer L0/L1 跨章扫描", () => {
  it("检测「」配对不完整（D5 对话格式保护，jp 模式）", () => {
    const issues = scanAllChapters(
      [{ id: "ch004", source: "「こんにちは」", translation: "「你好" }], // 缺闭合
      "jp"
    );
    const fmt = issues.find((i) => i.type === "dialogue_format");
    expect(fmt).toBeDefined();
    expect(fmt!.severity).toBe("high");
    expect(fmt!.dialogueSafe).toBe(false); // 禁止机械替换
  });

  it("干净的中文译文零问题", () => {
    const issues = scanAllChapters(
      [{ id: "ch005", source: "普通の文章。", translation: "普通的句子。" }]
    );
    expect(issues).toEqual([]);
  });

  it("【待审:原文】标记里的日文不触发任何检查（标记会被剥离）", () => {
    const issues = scanAllChapters(
      [{ id: "ch006", source: "アイテムボックスを開けた。", translation: "打开了【待审:アイテムボックス】。" }]
    );
    expect(issues).toEqual([]);
  });

  it("谐音梗译注只查这一章真的出现过的梗——没出现的不该在每章都报一遍", () => {
    // 作者实测（2026-08-13）：在第 1 章登记了一条缺译注的梗，之后**每一章**点审校都报它两遍，
    // 而那些章里根本没有这个词；梗不在本章 → 定位不到段落 → 界面退化成只显示一个文件名，点了也跳不动。
    const puns = [{ ja: "布石", zh: "普艾斯泰姆", note: "与「伏笔」同音" }];
    const issues = scanAllChapters(
      [
        { id: "ch001", source: "布石を打つ。", translation: "落下普艾斯泰姆。" },
        { id: "ch002", source: "今日はいい天気。", translation: "今天天气不错。" },
      ],
      "zh",
      puns,
    );
    const punIssues = issues.filter((i) => i.type === "pun_note_missing");
    // 原文里有梗词的那一章照报（缺译注是真的）
    expect(punIssues.map((i) => i.chapterId)).toEqual(["ch001"]);
  });

  it("译文里已出现译法的章节仍要查译注——梗词不在原文也算这一章的事", () => {
    const puns = [{ ja: "布石", zh: "普艾斯泰姆", note: "与「伏笔」同音" }];
    const issues = scanAllChapters(
      [{ id: "ch003", source: "何気ない一手。", translation: "看似随意的普艾斯泰姆。" }],
      "zh",
      puns,
    );
    expect(issues.filter((i) => i.type === "pun_note_missing").map((i) => i.chapterId)).toEqual(["ch003"]);
  });

  it("术语表里译注留空 → 这个梗不再查译注（界面上一直是这么承诺的）", () => {
    // 提示原文：「若这个梗不需要译注，把术语表里的译注留空，这条就不再出现。」
    // 而这里从来没读过 note，作者照做之后条目纹丝不动——软件说了一件它没做的事。
    const issues = scanAllChapters(
      [{ id: "ch001", source: "布石を打つ。", translation: "落下普艾斯泰姆。" }],
      "zh",
      [{ ja: "布石", zh: "普艾斯泰姆" }],
    );
    expect(issues.filter((i) => i.type === "pun_note_missing")).toEqual([]);
  });

  it("别处的译注不能替这个梗交差——判据是译法所在的那一段", () => {
    const issues = scanAllChapters(
      [{
        id: "ch001",
        source: "布石を打つ。",
        translation: "他望着窗外。（译注: 这里指校门口那棵银杏）\n落下普艾斯泰姆。",
      }],
      "zh",
      [{ ja: "布石", zh: "普艾斯泰姆", note: "与「伏笔」同音" }],
    );
    expect(issues.filter((i) => i.type === "pun_note_missing")).toHaveLength(1);
  });

  it("译法那一段跟着译注 → 通过", () => {
    const issues = scanAllChapters(
      [{ id: "ch001", source: "布石を打つ。", translation: "落下普艾斯泰姆。（译注: 与「伏笔」同音）" }],
      "zh",
      [{ ja: "布石", zh: "普艾斯泰姆", note: "与「伏笔」同音" }],
    );
    expect(issues.filter((i) => i.type === "pun_note_missing")).toEqual([]);
  });

  it("多章节扫描汇总全部问题（逐章独立判定，chapterId 不串）", () => {
    const issues = scanAllChapters(
      [
        { id: "ch001", source: "「あ」", translation: "「啊" },
        { id: "ch002", source: "「い」", translation: "「咦" },
      ],
      "jp"
    );
    const hits = issues.filter((i) => i.type === "dialogue_format");
    expect(hits).toHaveLength(2);
    expect(hits[0]!.chapterId).toBe("ch001");
    expect(hits[1]!.chapterId).toBe("ch002");
  });
});

describe("reviewer-scan 二次保证（整段未译 + 注音残留）", () => {
  it("译文整段日文残留 → untranslated", () => {
    const issues = scanAllChapters(
      [{ id: "ch001", source: "こんにちは、アリス。", translation: "こんにちは、アリス。\n\nここはまだ日本語のまま。" }]);
    const untr = issues.filter((i) => i.type === "untranslated");
    expect(untr.length).toBeGreaterThan(0);
    expect(untr[0]!.severity).toBe("high");
  });

  it("译文含平假名括注 → kana_note，且只报 low（判不出对错，裁定归作者）", () => {
    const issues = scanAllChapters(
      [{ id: "ch001", source: "森村透(とおる)は言った。", translation: "「森村透（とおる）说」\n\n森村透笑了笑。" }]);
    const notes = issues.filter((i) => i.type === "kana_note");
    expect(notes.length).toBeGreaterThan(0);
    // 有意保留读音与原文没删干净是同一个形状——不能按 medium 报得像个错误
    expect(notes.every((i) => i.severity === "low")).toBe(true);
  });

  it("双重阅读合法保留（黑炎（Hellfire）片假名/拉丁）→ 不误报", () => {
    const issues = scanAllChapters(
      [{ id: "ch001", source: "黒炎(ヘルファイア)は燃える。", translation: "黑炎（Hellfire）燃烧起来。" }]);
    expect(issues.filter((i) => i.type === "kana_note")).toHaveLength(0);
    expect(issues.filter((i) => i.type === "untranslated")).toHaveLength(0);
  });

  it("正常中文译文 → 无未译/注音问题", () => {
    const issues = scanAllChapters(
      [{ id: "ch001", source: "「こんにちは」アリスが言った。", translation: "「你好。」爱丽丝说道。" }]);
    expect(issues.filter((i) => i.type === "untranslated" || i.type === "kana_note")).toHaveLength(0);
  });
});

describe("quoteStyle 引号策略", () => {
  it("zh 模式（默认）检测 “” 配对", () => {
    const issues = scanAllChapters(
      [{ id: "ch007", source: "「こんにちは」", translation: "“你好" }], // 缺闭合
      "zh"
    );
    expect(issues.find((i) => i.type === "dialogue_format")).toBeDefined();
  });

  it("zh 模式：完整的 “” 不报问题", () => {
    const issues = scanAllChapters(
      [{ id: "ch008", source: "「こんにちは」", translation: "“你好。”" }],
      "zh"
    );
    expect(issues.filter((i) => i.type === "dialogue_format")).toHaveLength(0);
  });

  it("jp 模式：检测 「」 配对（互不干扰）", () => {
    const issues = scanAllChapters(
      [{ id: "ch009", source: "「こんにちは」", translation: "“你好。”" }], // jp 模式下 “” 不算对话
      "jp"
    );
    expect(issues.filter((i) => i.type === "dialogue_format")).toHaveLength(0);
  });
});

// R0-1：引号规整由 L0 后处理兑现，本检查是后处理没跑的回归探测器
describe("异风格引号残留（后处理回归探测器）", () => {
  it("zh 模式下译文残留日式引号 → quote_style_leftover（medium）", () => {
    const issues = scanAllChapters(
      [{ id: "ch010", source: "「こんにちは」", translation: "第一行\n「你好。」爱丽丝说道。" }],
      "zh"
    );
    const leftover = issues.filter((i) => i.type === "quote_style_leftover");
    expect(leftover).toHaveLength(1);
    expect(leftover[0]!.severity).toBe("medium"); // 不触发整章重译风暴
    expect(leftover[0]!.location).toBe("ch010_zh.md:2");
    expect(leftover[0]!.found).toContain("「");
  });

  it("『』 同样计入残留", () => {
    const issues = scanAllChapters(
      [{ id: "ch011", source: "『本』", translation: "他翻开『魔导书』。" }],
      "zh"
    );
    expect(issues.filter((i) => i.type === "quote_style_leftover")).toHaveLength(1);
  });

  it("后处理生效的译文 → 零检出", () => {
    const issues = scanAllChapters(
      [{ id: "ch012", source: "「こんにちは」", translation: "“你好。”爱丽丝说道。" }],
      "zh"
    );
    expect(issues.filter((i) => i.type === "quote_style_leftover")).toHaveLength(0);
  });

  it("jp 模式：中文引号才是异风格", () => {
    const jp = scanAllChapters(
      [{ id: "ch013", source: "「こんにちは」", translation: "“你好。”" }],
      "jp"
    );
    expect(jp.filter((i) => i.type === "quote_style_leftover")).toHaveLength(1);
    const clean = scanAllChapters(
      [{ id: "ch014", source: "「こんにちは」", translation: "「你好。」" }],
      "jp"
    );
    expect(clean.filter((i) => i.type === "quote_style_leftover")).toHaveLength(0);
  });
});

describe("R1-3 禁翻表审计", () => {
  it("原文含禁翻词而译文缺失 → no_translate_missing（high）", () => {
    const issues = scanAllChapters(
      [{ id: "ch020", source: "部屋のWi-Fiが切れた。", translation: "房间的无线网断了。" }],
      "zh",
      [],
      { noTranslate: [{ ja: "Wi-Fi" }] }
    );
    const hit = issues.find((i) => i.type === "no_translate_missing");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("high");
    expect(hit!.expected).toBe("Wi-Fi");
    // 机械替换需要「把什么换成什么」，而禁翻词被译成了什么无从得知 → 不走 replace_all
    expect(hit!.dialogueSafe).toBe(false);
  });

  it("译文原样保留禁翻词 → 零问题", () => {
    const issues = scanAllChapters(
      [{ id: "ch021", source: "部屋のWi-Fiが切れた。", translation: "房间的Wi-Fi断了。" }],
      "zh",
      [],
      { noTranslate: [{ ja: "Wi-Fi" }] }
    );
    expect(issues.filter((i) => i.type === "no_translate_missing")).toHaveLength(0);
  });

  it("原文不含该禁翻词 → 不误报", () => {
    const issues = scanAllChapters(
      [{ id: "ch022", source: "何もない。", translation: "什么都没有。" }],
      "zh",
      [],
      { noTranslate: [{ ja: "Wi-Fi" }] }
    );
    expect(issues.filter((i) => i.type === "no_translate_missing")).toHaveLength(0);
  });

  it("禁翻词只出现在【待审:】标记里不算保留（标记会被剥离）", () => {
    const issues = scanAllChapters(
      [{ id: "ch023", source: "スキルを使う。", translation: "使用技能【待审:スキル】。" }],
      "zh",
      [],
      { noTranslate: [{ ja: "スキル" }] }
    );
    expect(issues.filter((i) => i.type === "no_translate_missing")).toHaveLength(1);
  });

  it("无禁翻表时不误报", () => {
    const issues = scanAllChapters(
      [{ id: "ch024", source: "森村透が灯と話した。", translation: "森村透和灯说话了。" }]
    );
    expect(issues).toEqual([]);
  });
});
