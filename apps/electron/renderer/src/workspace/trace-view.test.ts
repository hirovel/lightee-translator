import { describe, expect, it } from "vitest";
import { formatTraceMs, traceSearchMatch, traceStats, traceTimeline } from "./trace-view.js";

describe("轨迹时间线", () => {
  it("按真实起止时间铺色块，新→旧输入也按旧→新排轴；工具轮进工具轨", () => {
    const segments = traceTimeline([
      { id: "b", ok: true, ms: 1000, ts: 2000, toolCallCount: 2 },
      { id: "a", ok: false, ms: 1000, ts: 1000 },
    ]);
    expect(segments.map((segment) => segment.id)).toEqual(["a", "b"]);
    expect(segments[0]!.kind).toBe("err");
    expect(segments[0]!.lane).toBe(0);
    expect(segments[0]!.leftPct).toBe(0);
    expect(segments[1]!.kind).toBe("tool");
    expect(segments[1]!.lane).toBe(1);
    expect(segments[1]!.leftPct).toBe(50);
  });

  it("毫秒级调用有可点击的最小宽度", () => {
    const segments = traceTimeline([
      { id: "t", ok: true, ms: 3, ts: 0, toolCallCount: 2 },
      { id: "l", ok: true, ms: 60_000, ts: 100 },
    ]);
    expect(segments.find((segment) => segment.id === "t")!.widthPct).toBeGreaterThan(0);
  });

  it("等宽模式：每次调用一个槽位，与真实时长无关（对应其 Duration 开关）", () => {
    const segments = traceTimeline(
      [
        { id: "a", ok: true, ms: 1, ts: 0 },
        { id: "b", ok: true, ms: 100_000, ts: 10 },
        { id: "c", ok: true, ms: 5, ts: 200_000 },
      ],
      "equal",
    );
    expect(segments.map((segment) => Math.round(segment.leftPct))).toEqual([0, 33, 67]);
    const widths = new Set(segments.map((segment) => segment.widthPct.toFixed(2)));
    expect(widths.size).toBe(1);
  });

  it("空账本不画轴", () => {
    expect(traceTimeline([])).toEqual([]);
  });
});

describe("轨迹搜索匹配", () => {
  it("空格分词、全部词均需命中、不区分大小写（其索引规则）", () => {
    expect(traceSearchMatch("翻译 deepseek-v4-pro 缓存命中", "V4 翻译")).toBe(true);
    expect(traceSearchMatch("翻译 deepseek-v4-pro", "v4 审校")).toBe(false);
    expect(traceSearchMatch("任何内容", "  ")).toBe(true);
  });
});

describe("轨迹统计条", () => {
  it("只报账本里真实存在的量（不编首 token / 工具耗时）", () => {
    const text = traceStats(
      [
        { id: "a", ok: true, ms: 60_000, ts: 0 },
        { id: "b", ok: false, ms: 30_000, ts: 1, toolCallCount: 1 },
      ],
      { input: 1000, output: 5000, cacheRead: 3000, cacheWrite: 0 },
    );
    expect(text).toContain("2 次调用（失败 1） · 工具轮 1");
    expect(text).toContain("LLM 耗时 1m30s");
    expect(text).toContain("缓存命中 75%");
    expect(text).not.toMatch(/首 ?token|工具耗时/);
  });

  it("无 totals 时统计条不出现 token 段；空账本给空串", () => {
    expect(traceStats([{ id: "a", ok: true, ms: 10, ts: 0 }], undefined)).not.toContain("tok");
    expect(traceStats([], undefined)).toBe("");
  });
});

describe("时长文案", () => {
  it("毫秒/秒/分三段式", () => {
    expect(formatTraceMs(800)).toBe("800ms");
    expect(formatTraceMs(9_500)).toBe("9.5s");
    expect(formatTraceMs(59_000)).toBe("59s");
    expect(formatTraceMs(125_000)).toBe("2m5s");
  });
});
