/**
 * R1 字典引擎测试：译前/译后字典的条目应用与禁翻表注入行。
 */
import { describe, it, expect } from "vitest";
import {
  applyDictionary,
  applyPreTransforms,
  buildNoTranslateLines,
  readDictionaries,
} from "../src/dictionary.ts";

describe("applyDictionary", () => {
  it("字面量条目按出现全部替换", () => {
    expect(applyDictionary("道具箱和道具箱", [{ find: "道具箱", replace: "物品栏" }])).toBe("物品栏和物品栏");
  });

  it("字面量条目不解释正则元字符", () => {
    expect(applyDictionary("a.c abc", [{ find: "a.c", replace: "X" }])).toBe("X abc");
  });

  it("字面量替换文本里的 $& 不被当成捕获引用", () => {
    expect(applyDictionary("旧词", [{ find: "旧词", replace: "$&新" }])).toBe("$&新");
  });

  it("正则条目需显式标记 type=regex，并支持捕获引用", () => {
    expect(applyDictionary("第12話", [{ find: "第(\\d+)話", replace: "第$1话", type: "regex" }])).toBe("第12话");
  });

  it("条目按序执行，后条目看得到前条目的结果", () => {
    const out = applyDictionary("甲", [
      { find: "甲", replace: "乙" },
      { find: "乙", replace: "丙" },
    ]);
    expect(out).toBe("丙");
  });

  it("非法正则被跳过而不是整条管线炸掉", () => {
    const out = applyDictionary("原文", [
      { find: "([", replace: "X", type: "regex" },
      { find: "原文", replace: "译文" },
    ]);
    expect(out).toBe("译文");
  });

  it("enabled=false 与空 find 的条目不参与", () => {
    expect(applyDictionary("原文", [
      { find: "原文", replace: "关掉了", enabled: false },
      { find: "", replace: "X" },
    ])).toBe("原文");
  });

  it("空条目表是恒等变换", () => {
    expect(applyDictionary("原文", [])).toBe("原文");
    expect(applyPreTransforms("原文", [])).toBe("原文");
  });
});

describe("buildNoTranslateLines", () => {
  it("只注入本章原文出现的禁翻词，格式为恒等映射", () => {
    const lines = buildNoTranslateLines(
      [{ ja: "Wi-Fi" }, { ja: "スキル" }],
      "部屋のWi-Fiが切れた。"
    );
    expect(lines).toBe("- Wi-Fi → Wi-Fi（禁译，原样保留）");
  });

  it("本章无禁翻词 → 空串", () => {
    expect(buildNoTranslateLines([{ ja: "Wi-Fi" }], "何もない。")).toBe("");
  });

  it("enabled=false 的条目不注入", () => {
    expect(buildNoTranslateLines([{ ja: "Wi-Fi", enabled: false }], "Wi-Fiが切れた。")).toBe("");
  });
});

describe("readDictionaries", () => {
  it("从仓库档案读出三类字典并丢弃残缺条目", () => {
    const dicts = readDictionaries({
      preDict: [{ find: "―", replace: "——" }, { replace: "无 find" }],
      postDict: [{ find: "的的", replace: "的", type: "literal" }],
      noTranslate: [{ ja: "Wi-Fi" }, { ja: "" }],
    });
    expect(dicts.preDict).toHaveLength(1);
    expect(dicts.preDict[0]).toMatchObject({ find: "―", replace: "——" });
    expect(dicts.postDict.map((e) => e.find)).toEqual(["的的"]);
    expect(dicts.noTranslate.map((e) => e.ja)).toEqual(["Wi-Fi"]);
  });

  it("档案缺失 → 三个空表（旧工作区不炸）", () => {
    const dicts = readDictionaries({});
    expect(dicts).toEqual({ preDict: [], postDict: [], noTranslate: [] });
  });
});
