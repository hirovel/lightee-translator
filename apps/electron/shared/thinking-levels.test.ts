/**
 * 思考档位的判定语义（2026-08-10 用户报告：「思考强度仍然锁定」）。
 *
 * 缺陷形态：⟳ 检测模型只写 `{id, name}`，没有 `thinkingLevelMap`；渲染层看到没有 map 就
 * 返回空档位列表，把下拉禁用成「能力未探测」，而**任何界面都不能写这个 map**——只能手改
 * `~/.lightee/models.json`。于是那个下拉是个永远打不开的死控件。
 *
 * 更根本的是规则错位：pi-ai 的 `getSupportedThinkingLevels` 语义是
 *   · `null`      → 明确不支持
 *   · 未写        → **透传支持**（原样把档位名发给服务商）
 *   · `xhigh`/`max` → 必须显式写条目，否则会被 clamp 降级
 * 渲染层比运行时严得多，把运行时明明接受的档位也锁掉了。本模块统一到运行时语义，
 * 并把「有依据」与「能用」分成两件事：未探测的档位可选，但要标出来它没有依据。
 */
import { describe, expect, it } from "vitest";
import {
  supportedThinkingLevels,
  identifyThinkingPreset,
  THINKING_PRESET_MAPS,
  type ThinkingLevelMap,
} from "./thinking-levels.js";

const ids = (map: ThinkingLevelMap | undefined): string[] => supportedThinkingLevels(map).map((level) => level.id);

describe("思考档位可用性（与 pi-ai getSupportedThinkingLevels 同语义）", () => {
  it("没有 map ≠ 不可用：运行时透传 off..high，只有 xhigh/max 需要显式条目", () => {
    expect(ids(undefined)).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("没有 map 的档位标记为「未探测」——可选，但不谎称有依据", () => {
    expect(supportedThinkingLevels(undefined).every((level) => !level.proven)).toBe(true);
  });

  it("null 是唯一的「明确不支持」", () => {
    const map: ThinkingLevelMap = { off: "none", minimal: null, low: "low", medium: null, high: "high" };
    expect(ids(map)).toEqual(["off", "low", "high"]);
  });

  it("显式写了条目的档位标记为有依据", () => {
    const levels = supportedThinkingLevels({ off: "none", low: "low" });
    expect(levels.find((level) => level.id === "low")?.proven).toBe(true);
    expect(levels.find((level) => level.id === "medium")?.proven).toBe(false);
  });

  it("xhigh/max 必须显式写条目才出现（否则运行时会静默降级成 high）", () => {
    expect(ids({ off: "none", high: "high" })).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(ids({ off: "none", high: "high", xhigh: "max", max: "max" })).toContain("xhigh");
    expect(ids({ off: "none", high: "high", xhigh: "max", max: "max" })).toContain("max");
  });

  it("空 map 与没有 map 等价（手工清空不该变成「全部不支持」）", () => {
    expect(ids({})).toEqual(ids(undefined));
  });

  it("除「不支持思考」外都至少给出一个档位——下拉不该莫名其妙变成零选项", () => {
    for (const map of [undefined, {}, THINKING_PRESET_MAPS.standard, THINKING_PRESET_MAPS.full]) {
      expect(supportedThinkingLevels(map).length).toBeGreaterThan(0);
    }
  });

  it("零档位只有一个来源：全 null 的「不支持思考」——UI 据此显示为已定论而非未探测", () => {
    expect(supportedThinkingLevels(THINKING_PRESET_MAPS.none)).toEqual([]);
  });
});

describe("思考档位预设（面板里给人选的形态，不是让人手填 map）", () => {
  it("「不支持思考」= 每一档都显式 null（含 off）", () => {
    // 其余档位「未写」在运行时等于透传支持，于是不会思考的模型仍会被发去 reasoning 参数；
    // 而 off 写成 "none" 是在断言服务商接受 effort:"none"——不接受的服务商会直接报错。
    // 全 null 时 pi-ai 完全不发送 reasoning 参数，这才是准确编码。
    expect(Object.values(THINKING_PRESET_MAPS.none).every((value) => value === null)).toBe(true);
  });

  it("「标准三档」= 低/中/高，不含 xhigh/max", () => {
    expect(ids(THINKING_PRESET_MAPS.standard)).toEqual(["off", "low", "medium", "high"]);
  });

  it("「全档位」含 xhigh/max", () => {
    expect(ids(THINKING_PRESET_MAPS.full)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("能从既有 map 反认出预设——否则面板每次打开都退化成「自定义」", () => {
    expect(identifyThinkingPreset(undefined)).toBe("unprobed");
    expect(identifyThinkingPreset({})).toBe("unprobed");
    expect(identifyThinkingPreset(THINKING_PRESET_MAPS.none)).toBe("none");
    expect(identifyThinkingPreset(THINKING_PRESET_MAPS.standard)).toBe("standard");
    expect(identifyThinkingPreset(THINKING_PRESET_MAPS.full)).toBe("full");
  });

  it("认不出的 map 是「自定义」，不是被静默改写成某个预设", () => {
    expect(identifyThinkingPreset({ off: "none", high: "ultra" })).toBe("custom");
  });

  it("探测产出的原样映射认作「已探测」，不是「自定义」", () => {
    // 用户刚跑完实测，界面却说「自定义」，读起来像是他手改过什么——
    // 「自定义」要留给真正手写的映射（把某档改名成服务商的私有字符串）。
    expect(identifyThinkingPreset({ off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" })).toBe("probed");
    expect(identifyThinkingPreset({ off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: "max" })).toBe("probed");
  });

  it("原样映射里只要有一档被改名，就退回「自定义」", () => {
    expect(identifyThinkingPreset({ off: "none", minimal: null, low: "low", medium: "medium", high: "max", xhigh: null, max: null })).toBe("custom");
  });

  it("三个具名预设优先于「已探测」——它们说得更具体", () => {
    expect(identifyThinkingPreset(THINKING_PRESET_MAPS.standard)).toBe("standard");
    expect(identifyThinkingPreset(THINKING_PRESET_MAPS.none)).toBe("none");
  });
});
