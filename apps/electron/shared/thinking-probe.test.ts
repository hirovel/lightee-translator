/**
 * 思考能力逐档探测的纯逻辑。
 *
 * 探测要解决的是一个具体的坑：直接用 `complete(ref, msgs, {thinking:"xhigh"})` 去试，
 * pi-ai 的 `clampThinkingLevel` 会因为模型没写 `xhigh` 条目而把它**静默降级成 high**，
 * 请求照样成功——于是探测会得出「xhigh 支持」这个错误结论。
 *
 * 破法：每次只让一个档位通路。给临时模型配一份 `{high: <候选字符串>, 其余全 null}` 的 map，
 * 然后请求 `high`——可用档位只剩 high，不触发 clamp，发出去的正是那个候选字符串。
 */
import { describe, expect, it } from "vitest";
import { PROBE_CANDIDATES, probeLevelMap, buildThinkingLevelMap, type ProbeOutcome } from "./thinking-probe.js";
import { supportedThinkingLevels, THINKING_PRESET_MAPS, identifyThinkingPreset } from "./thinking-levels.js";

const outcome = (candidate: string, accepted: boolean, reasoned = false): ProbeOutcome =>
  ({ candidate: candidate as ProbeOutcome["candidate"], accepted, reasoned });

const all = (accepted: boolean): ProbeOutcome[] => PROBE_CANDIDATES.map((c) => outcome(c, accepted));

describe("探测请求的构造", () => {
  it("只让 high 通向候选字符串，其余全 null —— 这样才不会被 clamp 降级", () => {
    const map = probeLevelMap("max");
    expect(map.high).toBe("max");
    for (const level of ["off", "minimal", "low", "medium", "xhigh", "max"]) {
      expect(map[level], `${level} 必须是 null，否则可用档位不止一个，clamp 会介入`).toBeNull();
    }
    // 可用档位恰好只有 high → 请求 high 时不发生降级
    expect(supportedThinkingLevels(map).map((l) => l.id)).toEqual(["high"]);
  });

  it("候选表覆盖全部七档，逐档实测而不是推断", () => {
    expect([...PROBE_CANDIDATES]).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });
});

describe("探测结果 → thinkingLevelMap", () => {
  it("全部被接受 → 全档位可用", () => {
    const map = buildThinkingLevelMap(all(true));
    expect(supportedThinkingLevels(map).map((l) => l.id)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("全部被拒 → 「不支持思考」，且此后完全不发送思考参数", () => {
    const map = buildThinkingLevelMap(all(false));
    expect(identifyThinkingPreset(map)).toBe("none");
    expect(supportedThinkingLevels(map)).toEqual([]);
  });

  it("只接受 none/low/medium/high → 恰好这四档可用", () => {
    const map = buildThinkingLevelMap([
      outcome("none", true), outcome("minimal", false), outcome("low", true),
      outcome("medium", true), outcome("high", true), outcome("xhigh", false), outcome("max", false),
    ]);
    expect(supportedThinkingLevels(map).map((l) => l.id)).toEqual(["off", "low", "medium", "high"]);
    expect(identifyThinkingPreset(map)).toBe("standard");
  });

  it("被拒的档位写成 null，而不是留空——留空在运行时等于透传支持", () => {
    const map = buildThinkingLevelMap([outcome("none", true), ...PROBE_CANDIDATES.slice(1).map((c) => outcome(c, false))]);
    for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(map[level], `${level} 应为 null`).toBeNull();
    }
  });

  it("绝不把某一档映射到别的档——探测的意义就是不做这种静默降级", () => {
    // max 被拒、high 被接受时，「最高」必须变成不可选，而不是偷偷等于「高」
    const map = buildThinkingLevelMap([
      outcome("none", true), outcome("minimal", false), outcome("low", true),
      outcome("medium", true), outcome("high", true), outcome("xhigh", false), outcome("max", false),
    ]);
    expect(map.max).toBeNull();
    expect(map.xhigh).toBeNull();
    // 被接受的档位一律原样映射，不改名
    expect(map.high).toBe("high");
    expect(map.low).toBe("low");
  });

  it("off 映射到服务商的 none；none 被拒时 off 不可选（关闭也得服务商认）", () => {
    expect(buildThinkingLevelMap(all(true)).off).toBe("none");
    const rejected = buildThinkingLevelMap([outcome("none", false), ...PROBE_CANDIDATES.slice(1).map((c) => outcome(c, true))]);
    expect(rejected.off).toBeNull();
  });

  it("「接受」与「真的返回了思考内容」是两件事——后者不折进 map", () => {
    const accepted = buildThinkingLevelMap(all(true));
    const acceptedNoReasoning = buildThinkingLevelMap(PROBE_CANDIDATES.map((c) => outcome(c, true, false)));
    expect(acceptedNoReasoning).toEqual(accepted);
  });

  it("结果里缺了某个候选（探测被中断）→ 当作不支持，绝不留空", () => {
    const partial = buildThinkingLevelMap([outcome("none", true), outcome("low", true)]);
    expect(partial.low).toBe("low");
    expect(partial.high).toBeNull();
    expect(partial.max).toBeNull();
  });

  it("产出的 map 只含已知档位键——不会把候选字符串本身写成键", () => {
    const map = buildThinkingLevelMap(all(true));
    expect(Object.keys(map).sort()).toEqual(["high", "low", "max", "medium", "minimal", "off", "xhigh"]);
  });

  it("全接受 = 原样映射，而不是套用「全档位」预设", () => {
    // 预设 full 是手工整理的断言（minimal→low、xhigh→max），适用于词表只有
    // none/low/medium/high/max 的服务商。探测得到的是实测事实，两者不该互相冒充。
    const map = buildThinkingLevelMap(all(true));
    expect(map).toEqual({ off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
    expect(map).not.toEqual(THINKING_PRESET_MAPS.full);
  });
});
