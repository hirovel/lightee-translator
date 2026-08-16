import { describe, expect, it } from "vitest";
import { formatMatchCount, pickCurrentIndex } from "./search-panel.js";

describe("pickCurrentIndex", () => {
  it("落在光标之后的第一个匹配上——与 findNext 同一套语义", () => {
    const starts = [10, 40, 90];
    expect(pickCurrentIndex(starts, 0)).toBe(1);
    expect(pickCurrentIndex(starts, 10)).toBe(1); // 光标正压在匹配头部
    expect(pickCurrentIndex(starts, 11)).toBe(2);
    expect(pickCurrentIndex(starts, 40)).toBe(2);
  });

  it("光标在最后一个匹配之后 → 回到第 1 个（findNext 会绕回去）", () => {
    expect(pickCurrentIndex([10, 40], 99)).toBe(1);
  });

  it("没有匹配就是 0，不编一个 1 出来", () => {
    expect(pickCurrentIndex([], 0)).toBe(0);
    expect(pickCurrentIndex([], 500)).toBe(0);
  });
});

describe("formatMatchCount", () => {
  it("常规形态 N/M", () => {
    expect(formatMatchCount(17, 3, false)).toBe("3/17");
  });

  it("零结果说「无结果」，不显示 0/0", () => {
    expect(formatMatchCount(0, 0, false)).toBe("无结果");
  });

  it("扫描触顶时总数带 +，不谎报一个精确值", () => {
    expect(formatMatchCount(999, 5, true)).toBe("5/999+");
  });
});
