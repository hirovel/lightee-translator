import { describe, expect, it } from "vitest";
import { buildParagraphs, paragraphsToText } from "@lightee/core/paragraph";
import { resolveIssueParagraphIds } from "../src/chapter-pipeline.ts";

/**
 * RH-03（DEF-03）：审校问题的行号定位必须落在真正的段落上。
 * 修复前的手写累加漏掉段间空行，第 2 段起全部错段或解析失败。
 */
describe("resolveIssueParagraphIds", () => {
  const paragraphs = [
    { id: "p0001", translation: "第一段。" },
    { id: "p0002", translation: "第二段。" },
    { id: "p0003", translation: "第三段。" },
    { id: "p0004", translation: "第四段。" },
  ];

  it("译文 md 投影的行号映射到正确的段落", () => {
    // 投影行：1=p0001 3=p0002 5=p0003 7=p0004
    expect(resolveIssueParagraphIds(paragraphs, "ch001_zh.md:1")).toEqual(["p0001"]);
    expect(resolveIssueParagraphIds(paragraphs, "ch001_zh.md:3")).toEqual(["p0002"]);
    expect(resolveIssueParagraphIds(paragraphs, "ch001_zh.md:5")).toEqual(["p0003"]);
    expect(resolveIssueParagraphIds(paragraphs, "ch001_zh.md:7")).toEqual(["p0004"]);
  });

  it("投影行号与 paragraphsToText 的实际输出一致", () => {
    const lines = paragraphsToText(buildParagraphs(paragraphs.map((p) => p.translation).join("\n\n"))).split("\n");
    expect(lines[4]).toBe("第三段。");
    expect(resolveIssueParagraphIds(paragraphs, "ch001_zh.md:5")).toEqual(["p0003"]);
  });

  it("命中段间空行 / 越界 / 无行号 → 空数组（显式降级，不猜相邻段）", () => {
    expect(resolveIssueParagraphIds(paragraphs, "ch001_zh.md:2")).toEqual([]);
    expect(resolveIssueParagraphIds(paragraphs, "ch001_zh.md:6")).toEqual([]);
    expect(resolveIssueParagraphIds(paragraphs, "ch001_zh.md:8")).toEqual([]);
    expect(resolveIssueParagraphIds(paragraphs, "ch001_zh.md")).toEqual([]);
    expect(resolveIssueParagraphIds(paragraphs, undefined)).toEqual([]);
    expect(resolveIssueParagraphIds([], "ch001_zh.md:1")).toEqual([]);
  });

  it("多行段落：段内每一行都映射到该段", () => {
    const multiline = [
      { id: "p0001", translation: "甲一\n甲二\n甲三" },
      { id: "p0002", translation: "乙" },
    ];
    expect([1, 2, 3].map((line) => resolveIssueParagraphIds(multiline, `x.md:${line}`))).toEqual([["p0001"], ["p0001"], ["p0001"]]);
    expect(resolveIssueParagraphIds(multiline, "x.md:4")).toEqual([]);
    expect(resolveIssueParagraphIds(multiline, "x.md:5")).toEqual(["p0002"]);
  });
});
