/**
 * PL-14：空响应降档梯子的总尝试预算。
 * 用假 provider 顶替 pi-ai，逐次记录尝试的 thinking 档位与网络调用次数。
 */
import { describe, expect, test, beforeEach, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  attempts: [] as string[],
  /** 每次流式调用产出的事件序列（由用例设置） */
  respond: (_thinking: string | undefined) => [] as unknown[],
}));

vi.mock("@earendil-works/pi-ai", () => ({
  lazyApi: (fn: unknown) => fn,
  createProvider: (cfg: { models?: Array<{ id: string }> }) => ({
    getModels: () => cfg.models ?? [],
    streamSimple: (_model: unknown, _context: unknown, opts: { reasoning?: string }) => {
      const thinking = opts.reasoning;
      hooks.attempts.push(thinking ?? "(未指定)");
      const events = hooks.respond(thinking);
      return (async function* () {
        for (const event of events) yield event;
      })();
    },
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

/** 空文本的正常结束事件 —— 触发「模型返回空响应」 */
const emptyDone = { type: "done", message: { content: [{ type: "thinking", thinking: "…" }], usage: undefined, stopReason: "stop" } };
/** 瞬态错误事件 —— retryCall 会在同一档位内重试 */
const transientError = { type: "error", error: { errorMessage: "503 service unavailable" } };

beforeEach(() => {
  hooks.attempts = [];
  hooks.respond = () => [emptyDone];
});

describe("空响应降档梯子（PL-14）", () => {
  test("每档一次瞬态 + 一次空响应 → 总尝试封顶 8 次并明确报错", async () => {
    const perThinking = new Map<string, number>();
    hooks.respond = (thinking) => {
      const seen = (perThinking.get(thinking ?? "") ?? 0) + 1;
      perThinking.set(thinking ?? "", seen);
      return seen === 1 ? [transientError] : [emptyDone];
    };

    const llm = runtime();
    const error = await llm
      .complete("fake/m", [{ role: "user", content: "x" }], {
        thinking: "max",
        retry: { maxRetries: 3, baseDelayMs: 0 },
      })
      .then(() => undefined, (e: unknown) => e as Error);

    expect(hooks.attempts).toHaveLength(8);
    expect(error?.message).toMatch(/空响应降档已达上限/);
    // 报错须说明试过哪些档位，否则用户只知道「失败了」
    expect(error?.message).toContain("max");
    expect(error?.message).toContain("medium");
  });

  test("降档链在预算内 → 保持逐档降级直到成功", async () => {
    hooks.respond = (thinking) =>
      thinking === "medium"
        ? [{ type: "done", message: { content: [{ type: "text", text: "译文" }], usage: undefined, stopReason: "stop" } }]
        : [emptyDone];

    const llm = runtime();
    const result = await llm.complete("fake/m", [{ role: "user", content: "x" }], {
      thinking: "max",
      retry: { maxRetries: 0 },
    });
    expect(result.text).toBe("译文");
    expect(hooks.attempts).toEqual(["max", "xhigh", "high", "medium"]);
  });
});
