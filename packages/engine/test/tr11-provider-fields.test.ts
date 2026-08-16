/**
 * TR-11：接住 pi-ai 已经给我们的字段。
 *
 * ## 审查发现
 *
 * pi-ai 的 `Usage` 与 `AssistantMessage` 提供的东西我们只取了一小半：
 *
 * | 字段 | 来源 | 此前 |
 * |---|---|---|
 * | `usage.reasoning` | `output_tokens_details.reasoning_tokens` | **丢弃** |
 * | `usage.cost`（逐项 + total） | pi 按模型价目算好 | **丢弃** |
 * | `usage.totalTokens` | — | 丢弃 |
 * | `rawStopReason` | 服务商原始状态，未经映射 | **丢弃** |
 * | `responseId` / `responseModel` | 服务商返回 | 丢弃 |
 *
 * `rawStopReason` 这一条代价最大：`stopReason` 把所有 `status:"incomplete"`
 * 一律映射成 `"length"`（openai-responses-shared.js:634），我据此断言过
 * 「原因未知」并花了很长时间用 output≈maxTokens 反推——**而未经映射的原始状态
 * 一直存在 `rawStopReason` 里**（同文件 446/616 行写入，completions 适配器
 * 327 行同理）。不是拿不到，是没读。
 *
 * `usage.reasoning` 同理：我建了一整套按字符估算推理量的东西（还标定了
 * 2.26 字符/token），而服务商上报的真实推理 token 数就在那儿。
 */
import { describe, expect, test, beforeEach, vi } from "vitest";

const hooks = vi.hoisted(() => ({ respond: () => [] as unknown[] }));

vi.mock("@earendil-works/pi-ai", () => ({
  lazyApi: (fn: unknown) => fn,
  createProvider: (cfg: { models?: Array<{ id: string }> }) => ({
    getModels: () => cfg.models ?? [],
    streamSimple: () => (async function* () { for (const e of hooks.respond()) yield e; })(),
  }),
}));

const { LlmRuntime } = await import("../src/llm-runtime.ts");

function runtime() {
  return LlmRuntime.create({
    configDir: "C:/nonexistent-lightee-config",
    historyFile: false,
    providers: { fake: { name: "fake", apiKey: "k", models: [{ id: "m" }] } },
  });
}

/** 服务商上报了推理 token 数与成本，且给了未经映射的原始状态 */
const rich = {
  type: "done",
  message: {
    content: [{ type: "thinking", thinking: "想" }, { type: "text", text: "译文" }],
    usage: {
      input: 100, output: 8000, cacheRead: 20, cacheWrite: 0,
      reasoning: 7500, totalTokens: 8120,
      cost: { input: 0.01, output: 0.8, cacheRead: 0.001, cacheWrite: 0, total: 0.811 },
    },
    stopReason: "stop",
    rawStopReason: "completed",
    responseId: "resp_abc123",
    responseModel: "deepseek-v4-flash-0731",
  },
};

beforeEach(() => { hooks.respond = () => [rich]; LlmRuntime.resetThinkingMemory(); });

describe("接住服务商上报的用量细分", () => {
  test("推理 token 数原样带出——它是上报值，不是我按字符估的", async () => {
    const result = await runtime().complete("fake/m", [{ role: "user", content: "x" }], { retry: { maxRetries: 0 } });
    expect(result.usage?.reasoning).toBe(7500);
  });

  test("成本原样带出：pi 已按模型价目算好，自己再乘一遍只会算错", async () => {
    const result = await runtime().complete("fake/m", [{ role: "user", content: "x" }], { retry: { maxRetries: 0 } });
    expect(result.usage?.cost?.total).toBeCloseTo(0.811);
    expect(result.usage?.cost?.output).toBeCloseTo(0.8);
  });

  test("服务商没上报细分时字段缺席，不补零——0 与「没说」是两件事", async () => {
    hooks.respond = () => [{ type: "done", message: { content: [{ type: "text", text: "译文" }], usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" } }];
    const result = await runtime().complete("fake/m", [{ role: "user", content: "x" }], { retry: { maxRetries: 0 } });
    expect(result.usage?.reasoning).toBeUndefined();
    expect(result.usage?.cost).toBeUndefined();
  });
});

describe("接住未经映射的原始停止原因", () => {
  test("rawStopReason 原样带出——stopReason 把所有 incomplete 压成 length，它没有", async () => {
    const result = await runtime().complete("fake/m", [{ role: "user", content: "x" }], { retry: { maxRetries: 0 } });
    expect(result.stopReason).toBe("stop");
    expect(result.rawStopReason).toBe("completed");
  });

  test("没有正文时也要把原始状态带出——那正是最需要它的时刻", async () => {
    hooks.respond = () => [{
      type: "done",
      message: {
        content: [{ type: "thinking", thinking: "推理".repeat(50) }],
        usage: { input: 1, output: 8192, cacheRead: 0, cacheWrite: 0, reasoning: 8192 },
        stopReason: "length",
        rawStopReason: "incomplete",
      },
    }];
    const error = await runtime()
      .complete("fake/m", [{ role: "user", content: "x" }], { thinking: "off", retry: { maxRetries: 0 } })
      .then(() => undefined, (e: unknown) => e as Error & { rawStopReason?: string; usage?: { reasoning?: number } });
    expect(error?.rawStopReason).toBe("incomplete");
    expect(error?.usage?.reasoning).toBe(8192);
  });
});

describe("接住响应标识", () => {
  test("responseId / responseModel 带出——前者是服务商侧的天然追溯锚点", async () => {
    const result = await runtime().complete("fake/m", [{ role: "user", content: "x" }], { retry: { maxRetries: 0 } });
    expect(result.responseId).toBe("resp_abc123");
    expect(result.responseModel).toBe("deepseek-v4-flash-0731");
  });
});
