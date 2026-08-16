import { describe, expect, it } from "vitest";
import { batchBlocks, splitBlocks } from "../src/batch.js";

/** 构造测试文本：n 段，每段 segLen 字符 */
function makeText(segCount: number, segLen: number, separatorAfter?: number[]): string {
  const segs: string[] = [];
  for (let i = 0; i < segCount; i++) {
    const body = `第${i}段${"あ".repeat(segLen - 3)}`;
    segs.push(separatorAfter?.includes(i) ? `${body}\n\n***\n\n` : body);
  }
  return segs.join("\n\n");
}

describe("段块切批", () => {
  it("分割段块：空行分隔", () => {
    const text = "一段。\n\n二段。\n\n三段。";
    const blocks = splitBlocks(text);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.text).toBe("一段。");
  });

  it("分隔符块被识别", () => {
    const text = "一段。\n\n***\n\n二段。";
    const blocks = splitBlocks(text);
    expect(blocks).toHaveLength(3);
    expect(blocks[1]?.endsWithSeparator).toBe(true);
  });

  it("正常切批：不超过目标字数", () => {
    const text = makeText(5, 100);
    const blocks = splitBlocks(text);
    const batches = batchBlocks(blocks, 250);
    // 5 段 × 100 字，目标 250 → 每批 2 段，最后 1 段
    expect(batches.length).toBeGreaterThanOrEqual(3);
    for (const b of batches) {
      expect(b.charCount).toBeLessThanOrEqual(250 + 100); // 允许最后一段溢出边界
    }
    // 所有批的段块数合计 = 5
    expect(batches.reduce((n, b) => n + b.blocks.length, 0)).toBe(5);
  });

  it("分隔符处优先切批", () => {
    const text = makeText(4, 50, [1]); // 第 2 段后是分隔符
    const blocks = splitBlocks(text);
    expect(blocks.some((b) => b.endsWithSeparator)).toBe(true);
    const batches = batchBlocks(blocks, 1000); // 目标很大，只有分隔符强制切
    // 分隔符独立成批（作者场景标记），前后内容各成一批
    expect(batches.length).toBe(3);
    // 中间批是分隔符
    expect(batches[1]?.blocks[0]?.endsWithSeparator).toBe(true);
    // 分隔符前的内容与分隔符后的内容不混批
    expect(batches[0]?.blocks.some((b) => b.endsWithSeparator)).toBe(false);
    expect(batches[2]?.blocks.some((b) => b.endsWithSeparator)).toBe(false);
  });

  it("超长单段：段内安全切（句末）", () => {
    const text = `「こんにちは。お元気ですか。今日はいい天気ですね。」${"あ".repeat(500)}`;
    const blocks = splitBlocks(text);
    const batches = batchBlocks(blocks, 100);
    // 超长段被强制切成多片
    expect(batches.filter((b) => b.containsForcedSplit).length).toBeGreaterThan(0);
    // 每片不超目标（含最后的余量）
    for (const b of batches) {
      expect(b.charCount).toBeLessThanOrEqual(100 + 50);
    }
  });

  it("空输入返回空", () => {
    expect(batchBlocks([], 100)).toEqual([]);
    expect(batchBlocks(splitBlocks(""), 100)).toEqual([]);
  });

  it("短文本单批", () => {
    const text = "短い。";
    const batches = batchBlocks(splitBlocks(text), 2000);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.estTokens).toBeGreaterThan(0);
  });

  it("确定性：同一输入两次切批结果一致", () => {
    const text = makeText(8, 80);
    const blocks = splitBlocks(text);
    const a = batchBlocks(blocks, 200);
    const b = batchBlocks(blocks, 200);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
