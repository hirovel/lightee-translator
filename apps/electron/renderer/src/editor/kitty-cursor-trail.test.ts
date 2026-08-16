import { describe, expect, it } from "vitest";
import {
  approachCorner,
  convexHull,
  movementNeedsTrail,
  rectCorners,
  resolveCursorBox,
  type CursorRect,
} from "./kitty-cursor-trail.js";

const rect = (left: number, top: number, width = 10, height = 20): CursorRect => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
});

describe("kitty cursor geometry", () => {
  it("approaches the target using elapsed time rather than a fixed frame step", () => {
    const shortFrame = approachCorner(0, 100, 1 / 120, 0.08);
    const longFrame = approachCorner(0, 100, 1 / 30, 0.08);
    expect(shortFrame).toBeGreaterThan(0);
    expect(longFrame).toBeGreaterThan(shortFrame);
    expect(approachCorner(100, 100, 1 / 60, 0.08)).toBe(100);
  });

  it("keeps a one-character horizontal move quiet but trails a larger jump", () => {
    expect(movementNeedsTrail(rect(0, 0), rect(10, 0), 10, 1, 0)).toBe(false);
    expect(movementNeedsTrail(rect(0, 0), rect(21, 0), 10, 1, 0)).toBe(true);
    expect(movementNeedsTrail(rect(0, 0), rect(0, 20), 10, 1, 0)).toBe(true);
  });

  it("builds a non-degenerate hull for a multi-line trail", () => {
    const start = rectCorners(rect(10, 20));
    const end = rectCorners(rect(30, 120));
    const hull = convexHull([...start, ...end]);
    expect(hull.length).toBeGreaterThanOrEqual(4);
    expect(hull.some((point) => point.y === 20)).toBe(true);
    expect(hull.some((point) => point.y === 140)).toBe(true);
  });
});

describe("光标方块的纵向几何", () => {
  // 作者实测报回的「光标跨行显示」：折行段落的 lineBlock.height 是整段高度，
  // 直接当光标高会画出纵跨两三行的大色块。
  it("折行段落里，光标高只占一个视觉行，且落在 caret 所在那一行", () => {
    // 一段折成 3 个视觉行（36px 一行），caret 在第 2 行（top 236 ~ bottom 264）
    const box = resolveCursorBox({
      blockTop: 200,
      blockHeight: 108,
      defaultLineHeight: 36,
      caretTop: 240,
      caretBottom: 264,
    });
    expect(box.height).toBe(36);
    expect(box.top).toBe(252 - 18); // 以 caret 中线 252 为准，不是段首 200
  });

  it("单行段落退化为原行为（与段首对齐、整段高即行高）", () => {
    const box = resolveCursorBox({
      blockTop: 200,
      blockHeight: 36,
      defaultLineHeight: 36,
      caretTop: 206,
      caretBottom: 230,
    });
    expect(box.height).toBe(36);
    expect(box.top).toBe(200);
  });

  it("caret 高度退化时回落段首，不产出负高或错位", () => {
    const box = resolveCursorBox({
      blockTop: 200,
      blockHeight: 0,
      defaultLineHeight: 0,
      caretTop: 240,
      caretBottom: 240,
    });
    expect(box.height).toBeGreaterThanOrEqual(1);
    expect(box.top).toBe(200);
  });
});
