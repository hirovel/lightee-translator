/**
 * PT-01：运行时工具通道。
 *
 * pi-ai 的 `Context.tools` 与 `ToolCall` 内容项一直都在（streamSimple 原生支持），
 * 此前「一次性对话调用（无工具）」只是我们没接。判据：
 * - tools 原样挂上 Context（不传时字段缺席——现有 596 条测试的行为一个字节不变）
 * - 模型回的 toolCall 内容项原样带出（schema 由服务商校验形状，真伪校验在 L0）
 */
import { describe, expect, test, beforeEach, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  seenContexts: [] as Array<Record<string, unknown>>,
  respond: () => [] as unknown[],
}));

vi.mock("@earendil-works/pi-ai", () => ({
  lazyApi: (fn: unknown) => fn,
  createProvider: (cfg: { models?: Array<{ id: string }> }) => ({
    getModels: () => cfg.models ?? [],
    streamSimple: (_model: unknown, context: Record<string, unknown>) => {
      hooks.seenContexts.push(context);
      return (async function* () { for (const e of hooks.respond()) yield e; })();
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

const REGISTER_TERMS = {
  name: "register_terms",
  description: "登记术语与语气档案",
  parameters: { type: "object", properties: {} },
};

const doneWith = (content: unknown[]) => [{
  type: "done",
  message: { content, usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" },
}];

beforeEach(() => {
  hooks.seenContexts = [];
  hooks.respond = () => doneWith([{ type: "text", text: "译文" }]);
  LlmRuntime.resetThinkingMemory();
});

describe("PT-01 工具通道", () => {
  test("tools 挂上 Context 原样发出", async () => {
    await runtime().complete("fake/m", [{ role: "user", content: "x" }], {
      tools: [REGISTER_TERMS] as never,
      retry: { maxRetries: 0 },
    });
    expect(hooks.seenContexts[0]!.tools).toEqual([REGISTER_TERMS]);
  });

  test("不传 tools 时 Context 上没有这个字段——存量行为一个字节不变", async () => {
    await runtime().complete("fake/m", [{ role: "user", content: "x" }], { retry: { maxRetries: 0 } });
    expect("tools" in hooks.seenContexts[0]!).toBe(false);
  });

  test("模型回的 toolCall 内容项原样带出，与正文并存", async () => {
    hooks.respond = () => doneWith([
      { type: "text", text: '<paragraph id="p0001">译文</paragraph>' },
      { type: "toolCall", id: "call_1", name: "register_terms", arguments: { terms: [{ ja: "ラウル", zh: "劳尔", type: "person" }] } },
    ]);
    const result = await runtime().complete("fake/m", [{ role: "user", content: "x" }], {
      tools: [REGISTER_TERMS] as never,
      retry: { maxRetries: 0 },
    });
    expect(result.text).toContain("p0001");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.name).toBe("register_terms");
    expect((result.toolCalls![0]!.arguments as { terms: Array<{ ja: string }> }).terms[0]!.ja).toBe("ラウル");
  });

  test("模型没调用工具时 toolCalls 缺席，不补空数组——「没调用」和「调用了0次」是一件事，但字段语义按缺席算", async () => {
    const result = await runtime().complete("fake/m", [{ role: "user", content: "x" }], {
      tools: [REGISTER_TERMS] as never,
      retry: { maxRetries: 0 },
    });
    expect(result.toolCalls).toBeUndefined();
  });
});
