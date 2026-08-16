import { describe, expect, it } from "vitest";
import { CACHE_RATE_NOTE, CACHE_RATE_TITLE, cacheHitRate, formatCallCache, formatHitRate } from "./cache-usage.js";

describe("单次调用的缓存摘要", () => {
  it("命中照样显示零值（命中 0 正是「打穿了前缀」的证据）；新存 > 0 才出现", () => {
    expect(formatCallCache({ input: 100, output: 20, cacheRead: 300, cacheWrite: 40 })).toBe("缓存命中 300 · 新存 40");
    expect(formatCallCache({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0 })).toBe("缓存命中 0");
  });

  it("服务商没上报的字段不冒充 0——「写 0」常驻正是这么来的", () => {
    expect(formatCallCache({ input: 100, output: 20, cacheRead: 500 })).toBe("缓存命中 500");
    expect(formatCallCache({ input: 100, output: 20 })).toBe("缓存未上报");
  });

  it("没有 usage → 不给摘要（没有数据和数据为零是两回事）", () => {
    expect(formatCallCache(undefined)).toBeNull();
  });
});

describe("缓存命中率", () => {
  // pi-ai 的 input 已剔除缓存读与缓存写（openai-completions.js:1075 / openai-responses-shared.js:428
  // 都做了 prompt_tokens - cacheRead - cacheWrite），因此提示词总量 = input + cacheRead + cacheWrite。
  it("分母是提示词总量：input + cacheRead + cacheWrite", () => {
    expect(cacheHitRate({ input: 100, output: 999, cacheRead: 300, cacheWrite: 100 })).toBeCloseTo(0.6, 10);
  });

  it("output 不参与——它不是提示词", () => {
    expect(cacheHitRate({ input: 50, output: 100_000, cacheRead: 50 })).toBeCloseTo(0.5, 10);
  });

  it("全冷跑 → 0", () => {
    expect(cacheHitRate({ input: 400, output: 20, cacheRead: 0, cacheWrite: 0 })).toBe(0);
  });

  it("提示词总量为 0（尚未调用）→ null，不显示 0% 骗人", () => {
    expect(cacheHitRate({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
    expect(cacheHitRate(undefined)).toBeNull();
  });

  it("格式化保留一位小数；无数据时给横杠", () => {
    expect(formatHitRate({ input: 100, output: 0, cacheRead: 300, cacheWrite: 100 })).toBe("60.0%");
    expect(formatHitRate({ input: 1, output: 0, cacheRead: 2, cacheWrite: 0 })).toBe("66.7%");
    expect(formatHitRate(undefined)).toBe("—");
  });

  it("口径标注为固定文案，且说明分母（用户据此判断能不能拿它对账）", () => {
    expect(CACHE_RATE_NOTE).toBe("近似值，以服务商账单为准");
    expect(CACHE_RATE_TITLE).toContain("缓存读 ÷（输入 + 缓存读 + 缓存写）");
    expect(CACHE_RATE_TITLE).toContain(CACHE_RATE_NOTE);
  });
});
