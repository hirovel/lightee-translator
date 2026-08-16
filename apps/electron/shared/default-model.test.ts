/**
 * 项目默认模型必须真的存在于内置预置服务商里（全新安装的第一条路径）。
 *
 * 缺陷形态：`config.json` 没写 `ai.model` 时，全链路一律回落到项目默认
 * `deepseek/deepseek-v4-pro`（config-service.resolveAgent / resolveReviewAgent /
 * testAi、workflow-service 的 Manager 装配，engine 侧的 DEFAULT_CONFIG 也是它）。
 * 但内置预置里的 deepseek 只有 chat / reasoner 两个模型——于是**全新安装**的用户
 * 什么都没改就翻译，拿到的是 `模型不存在: deepseek/deepseek-v4-pro`。
 *
 * 老用户看不到这个问题：他们点过 ⟳ 从真实接口拉过模型列表，v4 系列因此写进了自己的
 * models.json。默认值和预置表是两处各写各的，这条测试就是把它们钉在一起。
 */
import { describe, expect, it } from "vitest";
import { PRESET_PROVIDERS } from "./lightee-config.js";

/** 与 config-service.resolveAgent / workflow-service 的回落值保持一致（2026-08 起 pro 为默认） */
const DEFAULT_MODEL = "deepseek/deepseek-v4-pro";

function resolvable(ref: string): boolean {
  const providerId = ref.split("/")[0] ?? "";
  const modelId = ref.split("/").slice(1).join("/");
  const provider = PRESET_PROVIDERS.find((candidate) => candidate.id === providerId);
  return Boolean(provider?.models.some((model) => model.id === modelId));
}

describe("默认模型与内置预置的一致性", () => {
  it("默认模型在预置服务商的模型列表里——否则全新安装第一次翻译就报「模型不存在」", () => {
    expect(resolvable(DEFAULT_MODEL)).toBe(true);
  });

  it("预置里的每个服务商都至少有一个模型（空列表的服务商在 UI 里是死项）", () => {
    for (const provider of PRESET_PROVIDERS) {
      expect(provider.models.length, `${provider.id} 没有任何模型`).toBeGreaterThan(0);
    }
  });

  it("同一服务商内模型 id 不重复（重复项会让模型下拉出现两个同名条目）", () => {
    for (const provider of PRESET_PROVIDERS) {
      const ids = provider.models.map((model) => model.id);
      expect(new Set(ids).size, `${provider.id} 有重复模型 id`).toBe(ids.length);
    }
  });
});
