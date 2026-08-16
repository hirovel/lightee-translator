import { describe, expect, it } from "vitest";
import { resolveSelectedProvider } from "./ai-panel-state.js";

/**
 * master-detail 左列的选中判定。三条回落顺序都有具体的用户场景：
 * 用户刚点过谁 → 当前翻译模型属于谁 → 第一个。选错了的表现是「刚点的服务商被弹回去」。
 */
describe("服务商选中判定", () => {
  it("优先保持用户刚点选的那个", () => {
    expect(resolveSelectedProvider(["a", "b", "c"], "b", "c/m")).toBe("b");
  });

  it("没有有效偏好时，落到当前翻译模型所属的服务商", () => {
    expect(resolveSelectedProvider(["a", "b", "c"], "", "c/m")).toBe("c");
  });

  it("偏好指向已被删除的服务商 → 不能停在空选中", () => {
    expect(resolveSelectedProvider(["a", "b"], "ghost", "b/m")).toBe("b");
  });

  it("当前模型也指向不存在的服务商 → 落到第一个", () => {
    expect(resolveSelectedProvider(["a", "b"], "ghost", "ghost/m")).toBe("a");
  });

  it("一个服务商都没有 → 空串（详情面渲染空态，而不是崩在 undefined 上）", () => {
    expect(resolveSelectedProvider([], "a", "a/m")).toBe("");
  });

  it("模型 ref 含斜杠的模型名不会把服务商切错（只取第一段）", () => {
    expect(resolveSelectedProvider(["siliconflow"], "", "siliconflow/deepseek-ai/DeepSeek-V3")).toBe("siliconflow");
  });
});
