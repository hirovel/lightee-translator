/**
 * R0-1 译后处理（L0 确定性文本变换）：引号风格双射映射与异风格残留探测。
 */
import { describe, expect, it } from "vitest";
import { applyPostTransforms, applyQuoteStyle, findForeignQuotes } from "../src/post-transform.ts";

describe("applyQuoteStyle", () => {
  it("zh 模式：日式引号映射为中文引号（方向保持）", () => {
    expect(applyQuoteStyle("「こんにちは」", "zh")).toBe("“こんにちは”");
    expect(applyQuoteStyle("『书名』", "zh")).toBe("‘书名’");
  });

  it("jp 模式：中文引号映射回日式引号（反向双射）", () => {
    expect(applyQuoteStyle("“你好”", "jp")).toBe("「你好」");
    expect(applyQuoteStyle("‘书名’", "jp")).toBe("『书名』");
  });

  it("嵌套引号逐层映射，层级关系不变", () => {
    expect(applyQuoteStyle("「他说『再见』就走了」", "zh")).toBe("“他说‘再见’就走了”");
    expect(applyQuoteStyle("“他说‘再见’就走了”", "jp")).toBe("「他说『再见』就走了」");
  });

  it("幂等：目标风格字符不动，二次应用结果不变", () => {
    const once = applyQuoteStyle("「你好」", "zh");
    expect(applyQuoteStyle(once, "zh")).toBe(once);
    const jpOnce = applyQuoteStyle("“你好”", "jp");
    expect(applyQuoteStyle(jpOnce, "jp")).toBe(jpOnce);
  });

  it("混排文本：已是目标风格的引号原样保留，只规整异风格部分", () => {
    expect(applyQuoteStyle("“已规整”和「未规整」", "zh")).toBe("“已规整”和“未规整”");
  });

  it("非引号字符（方头括号/圆括号/待审标记）不受影响", () => {
    expect(applyQuoteStyle("道具箱【待审:アイテムボックス】（译注: x）", "zh")).toBe(
      "道具箱【待审:アイテムボックス】（译注: x）"
    );
  });

  it("双射：zh 映射后再 jp 映射回到原文", () => {
    const src = "「他说『再见』」";
    expect(applyQuoteStyle(applyQuoteStyle(src, "zh"), "jp")).toBe(src);
  });

  it("空串与无引号文本原样返回", () => {
    expect(applyQuoteStyle("", "zh")).toBe("");
    expect(applyQuoteStyle("没有引号的一段话。", "zh")).toBe("没有引号的一段话。");
  });
});

describe("findForeignQuotes", () => {
  it("zh 模式：命中日式引号并给出位置", () => {
    const hits = findForeignQuotes("正文\n「残留」", "zh");
    expect(hits.map((h) => h.char)).toEqual(["「", "」"]);
    expect(hits[0]!.index).toBe(3);
  });

  it("jp 模式：命中中文引号", () => {
    expect(findForeignQuotes("“残留”", "jp").map((h) => h.char)).toEqual(["“", "”"]);
  });

  it("已规整文本 → 零命中", () => {
    expect(findForeignQuotes(applyQuoteStyle("「你好」", "zh"), "zh")).toEqual([]);
  });
});

describe("R1-1 applyPostTransforms 译后管线", () => {
  it("无字典时等价于单独的引号映射（管线不改变既有行为）", () => {
    const src = "「你好」";
    expect(applyPostTransforms(src, { quoteStyle: "zh" })).toBe(applyQuoteStyle(src, "zh"));
  });

  it("步序固定：先引号映射，后译后字典 —— 字典能改写引号映射的结果", () => {
    const out = applyPostTransforms("「你好」", {
      quoteStyle: "zh",
      postDict: [{ find: "“你好”", replace: "「你好」" }],
    });
    expect(out).toBe("「你好」");
  });

  it("译后字典的正则条目按 type=regex 解释", () => {
    const out = applyPostTransforms("他他他跑了", {
      quoteStyle: "zh",
      postDict: [{ find: "(他)+", replace: "$1", type: "regex" }],
    });
    expect(out).toBe("他跑了");
  });

  it("译后字典不触碰【待审:】标记之外的结构", () => {
    const out = applyPostTransforms("道具箱【待审:アイテムボックス】", {
      quoteStyle: "zh",
      postDict: [{ find: "道具箱", replace: "物品栏" }],
    });
    expect(out).toBe("物品栏【待审:アイテムボックス】");
  });
});
