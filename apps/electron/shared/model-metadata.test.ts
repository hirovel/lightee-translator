import { describe, expect, it } from "vitest";
import { readContextLength } from "./model-metadata.js";

/**
 * 从服务商 `/models` 返回里读上下文窗口。
 *
 * 规则只有一条：**有就读，没有就不猜**。上下文窗口直接决定要不要把整本书注入上下文、
 * 以及 Manager 什么时候开始压缩——猜错一个数，代价是每次调用的成本或质量，
 * 而不是一个显示错误。所以任何拿不准的形态一律返回 undefined，让用户手填。
 */
describe("从 /models 条目读上下文窗口", () => {
  it("识别各家的字段名（同一件事，叫法不同）", () => {
    expect(readContextLength({ context_length: 1_000_000 })).toBe(1_000_000);
    expect(readContextLength({ context_window: 65_536 })).toBe(65_536);
    expect(readContextLength({ max_context_length: 32_768 })).toBe(32_768);
    expect(readContextLength({ max_model_len: 131_072 })).toBe(131_072);
  });

  it("识别 OpenRouter 那种嵌在 top_provider 里的写法", () => {
    expect(readContextLength({ top_provider: { context_length: 200_000 } })).toBe(200_000);
  });

  it("顶层字段优先于嵌套字段", () => {
    expect(readContextLength({ context_length: 128_000, top_provider: { context_length: 200_000 } })).toBe(128_000);
  });

  it("数字串照读——有些接口把数字序列化成字符串", () => {
    expect(readContextLength({ context_length: "65536" })).toBe(65_536);
  });

  it("没有任何相关字段 → undefined（不猜）", () => {
    expect(readContextLength({ id: "some-model", object: "model", owned_by: "acme" })).toBeUndefined();
  });

  it("形态可疑一律不采信——猜错一个数的代价在每次调用上", () => {
    for (const value of [0, -1, 1.5, "abc", "1e9", "", null, true, {}, []]) {
      expect(readContextLength({ context_length: value }), `context_length=${JSON.stringify(value)}`).toBeUndefined();
    }
    expect(readContextLength(null)).toBeUndefined();
    expect(readContextLength("nope")).toBeUndefined();
  });

  it("越界的荒谬值不采信（多半是把别的东西当成了窗口）", () => {
    expect(readContextLength({ context_length: 1 })).toBeUndefined();
    expect(readContextLength({ context_length: 1_000_000_000 })).toBeUndefined();
  });
});
