import { describe, expect, it } from "vitest";
import { ParagraphTextStream, type ParagraphChunk } from "./paragraph-stream.js";

/** 把一串 delta 依次喂进去，收集全部产出（含收尾） */
function stream(deltas: string[]): ParagraphChunk[] {
  const s = new ParagraphTextStream();
  const out = deltas.flatMap((d) => s.push(d));
  return [...out, ...s.finish()];
}

/** 只关心最终拼出来的文本 */
function textOf(chunks: ParagraphChunk[]): string {
  return chunks.map((c) => c.text).join("");
}

describe("段落剥离：整块到达", () => {
  it("剥掉标签，只放出段内文本", () => {
    const chunks = stream([`<paragraph id="p0001">你好。</paragraph>`]);
    expect(chunks).toEqual([{ paragraphId: "p0001", text: "你好。" }]);
  });

  it("一个 delta 里多段，逐段带上自己的 id", () => {
    const chunks = stream([
      `<paragraph id="p0001">第一段。</paragraph>\n<paragraph id="p0002">第二段。</paragraph>`,
    ]);
    expect(chunks).toEqual([
      { paragraphId: "p0001", text: "第一段。" },
      { paragraphId: "p0002", text: "第二段。" },
    ]);
  });

  it("段落之间的换行与空白不外泄", () => {
    expect(textOf(stream([`<paragraph id="p1">甲</paragraph>\n\n  \n<paragraph id="p2">乙</paragraph>`]))).toBe("甲乙");
  });
});

describe("段落剥离：标签被切在任意位置", () => {
  it("开标签横跨三个 delta", () => {
    expect(stream([`<parag`, `raph id="p00`, `01">你好。</paragraph>`]))
      .toEqual([{ paragraphId: "p0001", text: "你好。" }]);
  });

  it("闭标签横跨两个 delta——半个标签绝不能当译文吐出去", () => {
    const s = new ParagraphTextStream();
    const first = s.push(`<paragraph id="p1">你好。</para`);
    // 「</para」被扣住：它可能是闭标签的开头
    expect(textOf(first)).toBe("你好。");
    expect(textOf(first)).not.toContain("<");
    const second = s.push(`graph>`);
    expect(textOf(second)).toBe("");
  });

  it("逐字符喂也拼得回来（最狠的切法）", () => {
    const wire = `<paragraph id="p0007">早上好。</paragraph>`;
    const chunks = stream([...wire]);
    // 逐字到达时正文**本来就该分多块出去**——断言块数等于 1 是在要求缓冲攒够再放，
    // 那恰恰与"边到边显示"相反。要保证的是拼起来一字不差、归属一个不错。
    expect(textOf(chunks)).toBe("早上好。");
    expect([...new Set(chunks.map((c) => c.paragraphId))]).toEqual(["p0007"]);
  });

  it("正文里的 `<` 最终照样放出来，不会被永久扣住", () => {
    expect(textOf(stream([`<paragraph id="p1">a < b 成立</paragraph>`]))).toBe("a < b 成立");
  });
});

describe("段落剥离：收尾", () => {
  it("截断在段内 → 正文一个字都不丢（多数在 push 阶段就已放出）", () => {
    const s = new ParagraphTextStream();
    const pushed = s.push(`<paragraph id="p9">半句话没说`);
    // 没有待定的 `<`，所以这段在 push 时就安全放出了，finish 自然没得可交。
    // 判据是**总量**而不是"由谁交出"——后者是实现细节，前者才是不丢数据。
    expect(textOf([...pushed, ...s.finish()])).toBe("半句话没说");
  });

  it("截断时尾部扣着半个标签 → 那半个不算译文，但它之前的正文照样交出去", () => {
    const s = new ParagraphTextStream();
    const pushed = s.push(`<paragraph id="p9">说到一半</para`);
    const all = [...pushed, ...s.finish()];
    expect(textOf(all)).toBe("说到一半");
    expect(textOf(all)).not.toContain("<");
  });

  it("截断在段外 → 残片是标签碎片，不外泄", () => {
    const s = new ParagraphTextStream();
    s.push(`<paragraph id="p1">整段</paragraph>\n<parag`);
    expect(s.finish()).toEqual([]);
  });

  it("收尾两次不重复吐", () => {
    const s = new ParagraphTextStream();
    // finish 真的还有货可交，只有一种形态：扣住的那截以 `<` 开头但**不像标签**。
    // 纯文本在 push 阶段就已经放出去了，那时 finish 本来就该是空的。
    const pushed = s.push(`<paragraph id="p1">若 a <b 则成立`);
    expect(textOf(pushed)).toBe("若 a ");
    expect(s.finish()).toEqual([{ paragraphId: "p1", text: "<b 则成立" }]);
    expect(s.finish()).toEqual([]);
  });

  it("空流收尾不产出任何东西", () => {
    expect(new ParagraphTextStream().finish()).toEqual([]);
  });
});

describe("段落剥离：不吐标签是硬要求", () => {
  it("无论怎么切，产出里都不含 paragraph 标签的任何片段", () => {
    const wire = `<paragraph id="p0001">甲乙丙。</paragraph><paragraph id="p0002">丁戊。</paragraph>`;
    // 三种切法：整块、对半、逐字
    for (const deltas of [[wire], [wire.slice(0, 30), wire.slice(30)], [...wire]]) {
      const joined = textOf(stream(deltas));
      expect(joined).toBe("甲乙丙。丁戊。");
      expect(joined).not.toContain("paragraph");
      expect(joined).not.toContain("</");
    }
  });
});
