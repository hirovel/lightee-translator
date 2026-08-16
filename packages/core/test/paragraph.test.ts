import { describe, expect, it } from "vitest";
import {
  buildParagraphs,
  detectParagraphType,
  normalizeParagraphText,
  paragraphIndexForProjectedLine,
  paragraphsToText,
  paragraphsToXml,
  parseParagraphsXml,
  splitParagraphs,
  validateParagraphOrder,
  escapeXml,
  unescapeXml,
} from "../src/paragraph.js";

describe("normalizeParagraphText / splitParagraphs", () => {
  it("CRLF 与 CR 统一为 LF", () => {
    expect(normalizeParagraphText("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("连续空白行归并为单一段落分隔", () => {
    expect(normalizeParagraphText("段A\n\n\n\n段B")).toBe("段A\n\n段B");
    expect(normalizeParagraphText("段A\n\n\n段B")).toBe("段A\n\n段B");
  });

  it("去除行尾空白与首尾空行（normalize 层）", () => {
    expect(normalizeParagraphText("行1  \n行2\n\n\n  \n")).toBe("行1\n行2");
  });

  it("splitParagraphs 去除段首尾空白并过滤空段", () => {
    expect(splitParagraphs("  行1  \n\n  行2  ")).toEqual(["行1", "行2"]);
    expect(splitParagraphs("甲\n\n\n  \n\n乙")).toEqual(["甲", "乙"]);
    // 段落内软换行保留为一个段落
    expect(splitParagraphs(" 第一行\n第二行  ")).toEqual(["第一行\n第二行"]);
  });

  it("保留段落内软换行（单个 \\n）", () => {
    expect(normalizeParagraphText("第一行\n第二行\n\n下一段")).toBe("第一行\n第二行\n\n下一段");
  });

  it("splitParagraphs 过滤纯空白块", () => {
    expect(splitParagraphs("甲\n\n\n  \n\n乙")).toEqual(["甲", "乙"]);
  });
});

describe("detectParagraphType", () => {
  it("Markdown 标题 → heading", () => {
    expect(detectParagraphType("# 第1章")).toBe("heading");
  });

  it("日轻章节标题行（无句末标点）→ heading", () => {
    expect(detectParagraphType("第26話　「髪乾かして♡」")).toBe("heading");
    expect(detectParagraphType("第三章 新しい出会い")).toBe("heading");
  });

  it("正文含句号 → body（不被误判为标题）", () => {
    expect(detectParagraphType("第26話の話を思い出す。それは遠い昔のことだった。")).toBe("body");
    expect(detectParagraphType("夜の八時前。俺たちは夕食をとっていた。")).toBe("body");
  });

  it("分隔符段 → separator", () => {
    expect(detectParagraphType("***")).toBe("separator");
    expect(detectParagraphType("―――")).toBe("separator");
  });

  it("插图标记段 → image", () => {
    expect(detectParagraphType("[插图: img01.jpg]")).toBe("image");
  });

  it("普通正文 → body", () => {
    expect(detectParagraphType("「こんにちは」アリスが言った。")).toBe("body");
  });
});

describe("buildParagraphs", () => {
  it("按顺序生成 p0001... 并跳过空段", () => {
    const paragraphs = buildParagraphs("# 标题\n\n正文A\n\n正文B\n\n\n");
    expect(paragraphs.map((p) => p.id)).toEqual(["p0001", "p0002", "p0003"]);
    expect(paragraphs[0]).toMatchObject({ type: "heading", text: "# 标题" });
    expect(paragraphs[1]).toMatchObject({ type: "body", text: "正文A" });
    expect(paragraphs[2]).toMatchObject({ type: "body", text: "正文B" });
  });

  it("同一 canonical 源重复解析得到相同 ID/顺序", () => {
    const src = "甲\n\n乙\n\n丙";
    expect(buildParagraphs(src).map((p) => p.id)).toEqual(buildParagraphs(src).map((p) => p.id));
  });
});

describe("XML wire protocol", () => {
  it("escape/unescape 往返", () => {
    const text = 'a & b < c > d "e"';
    expect(unescapeXml(escapeXml(text))).toBe(text);
  });

  it("转义实体一趟还原：&amp;lt; 往返后仍是字面量 &lt;", () => {
    expect(escapeXml("&lt;")).toBe("&amp;lt;");
    expect(unescapeXml("&amp;lt;")).toBe("&lt;");
    expect(unescapeXml(escapeXml("&lt;"))).toBe("&lt;");
    expect(unescapeXml(escapeXml("&amp;gt; & <b>"))).toBe("&amp;gt; & <b>");
  });

  it("未列入映射的实体原样保留", () => {
    expect(unescapeXml("&nbsp;&copy;")).toBe("&nbsp;&copy;");
    expect(unescapeXml("&#39;")).toBe("'");
  });

  it("serialize → parse 往返保持 id/type/text", () => {
    const paragraphs = buildParagraphs("# 标题\n\n正文「へへ」 & <タグ>");
    const wire = paragraphsToXml(paragraphs);
    const { paragraphs: parsed, errors } = parseParagraphsXml(wire);
    expect(errors).toEqual([]);
    expect(parsed).toEqual(paragraphs);
  });

  it("兼容外层代码块包裹", () => {
    const paragraphs = buildParagraphs("甲\n\n乙");
    const wire = "```xml\n" + paragraphsToXml(paragraphs) + "\n```";
    const { paragraphs: parsed, errors } = parseParagraphsXml(wire);
    expect(errors).toEqual([]);
    expect(parsed.map((p) => p.id)).toEqual(["p0001", "p0002"]);
  });

  it("重复 ID 报 duplicate", () => {
    const wire = '<paragraph id="p0001">甲</paragraph>\n<paragraph id="p0001">乙</paragraph>';
    const { paragraphs, errors } = parseParagraphsXml(wire);
    expect(paragraphs).toHaveLength(2);
    expect(errors.map((e) => e.code)).toContain("duplicate");
  });

  it("未闭合标签报 malformed", () => {
    const { errors } = parseParagraphsXml('<paragraph id="p0001">甲');
    expect(errors.map((e) => e.code)).toContain("malformed");
  });

  it("未知 type 报 unknown_type", () => {
    const wire = '<paragraph id="p0001" type="poem">甲</paragraph>';
    const { errors } = parseParagraphsXml(wire);
    expect(errors.map((e) => e.code)).toContain("unknown_type");
  });

  // R0-5：模型爱在 wire 前后加寒暄与总结，这些赘语不该污染解析
  it("首个 <paragraph 之前的寒暄被剥离", () => {
    const wire = '好的，以下是翻译：\n\n<paragraph id="p0001">甲</paragraph>';
    const { paragraphs, errors, stripped } = parseParagraphsXml(wire);
    expect(errors).toEqual([]);
    expect(paragraphs.map((p) => p.text)).toEqual(["甲"]);
    expect(stripped.prefix).toBe("好的，以下是翻译：\n\n".length);
  });

  it("最后一个 </paragraph> 之后的尾注被剥离", () => {
    const wire = '<paragraph id="p0001">甲</paragraph>\n\n以上就是全部译文，如需调整请告知。';
    const { paragraphs, errors, stripped } = parseParagraphsXml(wire);
    expect(errors).toEqual([]);
    expect(paragraphs.map((p) => p.text)).toEqual(["甲"]);
    expect(stripped.suffix).toBeGreaterThan(0);
  });

  it("寒暄前缀 + 尾注同时存在 → 段落完整解析", () => {
    const wire =
      "好的：\n```xml\n" +
      '<paragraph id="p0001">甲</paragraph>\n<paragraph id="p0002">乙</paragraph>\n' +
      "```\n希望有帮助。";
    const { paragraphs, errors } = parseParagraphsXml(wire);
    expect(errors).toEqual([]);
    expect(paragraphs.map((p) => p.id)).toEqual(["p0001", "p0002"]);
    expect(paragraphs.map((p) => p.text)).toEqual(["甲", "乙"]);
  });

  it("全是寒暄没有任何段落 → empty（不再静默返回空列表零错误）", () => {
    const { paragraphs, errors } = parseParagraphsXml("好的，我这就开始翻译。");
    expect(paragraphs).toHaveLength(0);
    expect(errors.map((e) => e.code)).toContain("empty");
  });

  it("干净 wire → 剥离量为 0", () => {
    const { stripped } = parseParagraphsXml('<paragraph id="p0001">甲</paragraph>');
    expect(stripped).toEqual({ prefix: 0, suffix: 0 });
  });

  it("未闭合标签仍报 malformed（无闭合标签时不剥尾）", () => {
    const { errors } = parseParagraphsXml('好的：<paragraph id="p0001">甲');
    expect(errors.map((e) => e.code)).toContain("malformed");
  });

  it("空响应报 empty", () => {
    const { paragraphs, errors } = parseParagraphsXml("   ");
    expect(paragraphs).toHaveLength(0);
    expect(errors.map((e) => e.code)).toContain("empty");
  });
});

describe("validateParagraphOrder", () => {
  const parsed = [
    { id: "p0001", type: "body" as const, text: "甲" },
    { id: "p0002", type: "body" as const, text: "乙" },
    { id: "p0003", type: "body" as const, text: "丙" },
  ];

  it("完全一致 → 无错误", () => {
    expect(validateParagraphOrder(parsed, ["p0001", "p0002", "p0003"])).toEqual([]);
  });

  it("数量不符 → count_mismatch", () => {
    const errors = validateParagraphOrder(parsed.slice(0, 2), ["p0001", "p0002", "p0003"]);
    expect(errors.map((e) => e.code)).toContain("count_mismatch");
  });

  it("缺失 → missing", () => {
    const errors = validateParagraphOrder(parsed.slice(1), ["p0001", "p0002", "p0003"]);
    expect(errors.map((e) => e.code)).toContain("missing");
  });

  it("顺序不符 → out_of_order", () => {
    const errors = validateParagraphOrder([parsed[1]!, parsed[0]!, parsed[2]!], ["p0001", "p0002", "p0003"]);
    expect(errors.map((e) => e.code)).toContain("out_of_order");
  });
});

describe("paragraphsToText", () => {
  it("剥离标签还原纯文本", () => {
    const paragraphs = buildParagraphs("# 标题\n\n正文A");
    expect(paragraphsToText(paragraphs)).toBe("# 标题\n\n正文A");
  });
});

describe("paragraphIndexForProjectedLine", () => {
  const single = ["一", "二", "三", "四"];

  it("单行段落：正文行映射到对应下标", () => {
    // 投影：1=一 2=空 3=二 4=空 5=三 6=空 7=四
    expect(paragraphIndexForProjectedLine(single, 1)).toBe(0);
    expect(paragraphIndexForProjectedLine(single, 3)).toBe(1);
    expect(paragraphIndexForProjectedLine(single, 5)).toBe(2);
    expect(paragraphIndexForProjectedLine(single, 7)).toBe(3);
  });

  it("段间分隔空行不属于任何段落 → -1", () => {
    expect(paragraphIndexForProjectedLine(single, 2)).toBe(-1);
    expect(paragraphIndexForProjectedLine(single, 4)).toBe(-1);
    expect(paragraphIndexForProjectedLine(single, 6)).toBe(-1);
  });

  it("多行段落混排：逐行映射正确", () => {
    // 投影：1-3=段0 4=空 5=段1 6=空 7-8=段2
    const mixed = ["a1\na2\na3", "b1", "c1\nc2"];
    expect([1, 2, 3].map((line) => paragraphIndexForProjectedLine(mixed, line))).toEqual([0, 0, 0]);
    expect(paragraphIndexForProjectedLine(mixed, 4)).toBe(-1);
    expect(paragraphIndexForProjectedLine(mixed, 5)).toBe(1);
    expect(paragraphIndexForProjectedLine(mixed, 6)).toBe(-1);
    expect([7, 8].map((line) => paragraphIndexForProjectedLine(mixed, line))).toEqual([2, 2]);
  });

  it("与 paragraphsToText 的实际投影一致", () => {
    const paragraphs = buildParagraphs("# 标题\n\n正文A\n\n正文B\n\n正文C");
    const texts = paragraphs.map((p) => p.text);
    const lines = paragraphsToText(paragraphs).split("\n");
    for (let line = 1; line <= lines.length; line++) {
      const index = paragraphIndexForProjectedLine(texts, line);
      if (index === -1) expect(lines[line - 1]).toBe("");
      else expect(texts[index]!.split("\n")).toContain(lines[line - 1]);
    }
  });

  it("行号 0 / 负数 / 越界 / 非整数 → -1", () => {
    expect(paragraphIndexForProjectedLine(single, 0)).toBe(-1);
    expect(paragraphIndexForProjectedLine(single, -3)).toBe(-1);
    expect(paragraphIndexForProjectedLine(single, 8)).toBe(-1);
    expect(paragraphIndexForProjectedLine(single, 99)).toBe(-1);
    expect(paragraphIndexForProjectedLine(single, 1.5)).toBe(-1);
    expect(paragraphIndexForProjectedLine([], 1)).toBe(-1);
  });
});
