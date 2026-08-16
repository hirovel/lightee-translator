/**
 * KA 内核对齐 —— pi-ai 每一条返回都要有正确落点。
 *
 * 起因：同一个毛病已经犯了三遍，全是「pi 已经给了，我们没读」：
 *   1. `rawStopReason === "incomplete"`  →  曾用 `output ≈ maxTokens` 反推
 *   2. `usage.reasoning`（上报 token）   →  曾按字符估算占比
 *   3. `stopReason === "toolUse"`        →  用 `toolCalls.length > 0` 数数组
 *
 * 第三次说明补字段没用，根子是**方向**：`AssistantMessage.content[]` 被两次 `join`
 * 拍扁成 `text`/`reasoning`，签名、redacted 标记、块序在那一步全丢。所以本批把方向
 * 反过来——**原始消息是真相，text/reasoning 降为派生便利值**。
 *
 * 本文件钉的是「不许再丢」，不是「某个函数算得对」。
 */
import { describe, expect, test, beforeEach, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  /** 每次 streamSimple 收到的 context，用于断言回灌形状 */
  contexts: [] as unknown[],
  /** 每次 streamSimple 收到的 model，用于断言 compat 透传 */
  models: [] as unknown[],
  respond: (_thinking: string | undefined) => [] as unknown[],
}));

vi.mock("@earendil-works/pi-ai", () => ({
  lazyApi: (fn: unknown) => fn,
  createProvider: (cfg: { models?: Array<{ id: string }> }) => ({
    getModels: () => cfg.models ?? [],
    streamSimple: (model: unknown, context: unknown, opts: { reasoning?: string }) => {
      hooks.contexts.push(context);
      hooks.models.push(model);
      const events = hooks.respond(opts.reasoning);
      return (async function* () { for (const event of events) yield event; })();
    },
  }),
}));

const { LlmRuntime } = await import("../src/llm-runtime.ts");

function runtime(models?: Array<Record<string, unknown>>) {
  return LlmRuntime.create({
    configDir: "C:/nonexistent-lightee-config",
    historyFile: false,
    providers: { fake: { name: "fake", apiKey: "k", models: (models ?? [{ id: "m" }]) as never } },
  });
}

const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 };
const textDone = { type: "done", message: { content: [{ type: "text", text: "译文" }], usage, stopReason: "stop" } };

beforeEach(() => {
  hooks.contexts = [];
  hooks.models = [];
  hooks.respond = () => [textDone];
  LlmRuntime.resetThinkingMemory();
});

describe("KA-1 原始消息是真相", () => {
  test("成功调用把原始 assistant 消息原样带出（continuation）", async () => {
    const message = {
      content: [
        { type: "thinking", thinking: "想了想", thinkingSignature: "SIG-ENCRYPTED-BLOB" },
        { type: "text", text: "译文" },
      ],
      usage,
      stopReason: "stop",
      responseId: "resp-1",
    };
    hooks.respond = () => [{ type: "done", message }];
    const result = await runtime().complete("fake/m", [{ role: "user", content: "x" }], { retry: { maxRetries: 0 } });

    // 派生便利值不变（现有调用方一行不改）
    expect(result.text).toBe("译文");
    expect(result.reasoning).toBe("想了想");
    // 真相：原始 content 数组一字不动，签名还在
    expect(result.continuation).toBe(message);
    const blocks = (result.continuation as unknown as { content: Array<Record<string, unknown>> }).content;
    expect(blocks[0]?.thinkingSignature).toBe("SIG-ENCRYPTED-BLOB");
  });

  test("回灌 continuation 时原样放回 pi 的 messages，不做字段重建", async () => {
    const original = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "第一轮想的", thinkingSignature: "SIG-1" },
        { type: "toolCall", id: "call_1", name: "register_terms", arguments: { terms: [] }, thoughtSignature: "TSIG-1" },
      ],
      usage,
      stopReason: "toolUse",
    };
    await runtime().complete("fake/m", [
      { role: "user", content: "原文" },
      { role: "assistant", content: "", continuation: original },
      { role: "toolResult", content: "已登记 3 条", toolCallId: "call_1", toolName: "register_terms" },
    ], { retry: { maxRetries: 0 } });

    const sent = (hooks.contexts[0] as { messages: unknown[] }).messages;
    // 原对象引用直达 pi——中间没有任何一层把它拆开又拼回来
    expect(sent[1]).toBe(original);
  });

  test("没有 continuation 时仍走手工重建（假 LLM / 测试 / 构造历史都要用）", async () => {
    await runtime().complete("fake/m", [
      { role: "assistant", content: "上一轮", reasoning: "上一轮想的", toolCalls: [{ id: "c1", name: "t", arguments: {} }] },
    ], { retry: { maxRetries: 0 } });
    const sent = (hooks.contexts[0] as { messages: Array<{ content: Array<Record<string, unknown>> }> }).messages;
    expect(sent[0]?.content.map((c) => c.type)).toEqual(["thinking", "text", "toolCall"]);
  });
});

describe("KA-1 toolUse 是权威信号", () => {
  test("服务商报 toolUse 但没解析出工具调用 → 仍是 tool_call_only，不进降档梯子", async () => {
    // 这是数数组长度**必然判错**的那一格：今天 toolCalls 为空 → 判「空响应」→
    // 进降档梯子 → max/xhigh/high/… 一路白烧，而服务商早就说了这是 toolUse。
    hooks.respond = () => [{ type: "done", message: { content: [], usage, stopReason: "toolUse" } }];
    let thrown: unknown;
    try {
      await runtime().complete("fake/m", [{ role: "user", content: "x" }], { thinking: "max", retry: { maxRetries: 0 } });
    } catch (error) { thrown = error; }

    expect((thrown as { shapeKind?: string })?.shapeKind).toBe("tool_call_only");
    // 终局：只尝试一次。降档治不了工具协议（PT-02 实测 7/7 档位行为一致）
    expect((thrown as { attempts?: number })?.attempts ?? 1).toBe(1);
  });

  test("废尝试的 errorKind 由 shapeKind 派生，不再靠比较中文文案", async () => {
    hooks.respond = (thinking) => (thinking === "high"
      ? [textDone]
      : [{ type: "done", message: { content: [{ type: "thinking", thinking: "…" }], usage, stopReason: "stop" } }]);
    const result = await runtime().complete("fake/m", [{ role: "user", content: "x" }], { thinking: "max", retry: { maxRetries: 0 } });
    expect(result.wasted?.every((w) => w.errorKind === "empty_response")).toBe(true);
    // 文案换了词也不该影响分类——分类的依据是结构，不是字符串
    expect(result.wasted?.[0]?.shapeKind).toBe("empty_response");
  });
});

/**
 * KA-4 验收跑批（2026-08-12）三章全 stuck 的根因就在这一格，而当时**两侧的测试都是绿的**：
 * `llm-runtime` 只测了「抛出时形状对不对」，`translate-one` 的假体则直接 `return`
 * 一个工具轮——两边各自自洽，接缝上没有任何东西。真机上模型三章都正确调了
 * `register_terms`，运行时把它判成失败抛掉，`runToolTurns` 的 `await llm.complete()`
 * 永远拿不到返回值，第二轮从未组装。烧掉 68910 输出 token、2187 秒，产出 0 段正文。
 *
 * 判据是**调用方的期望**，不是响应本身：给了工具 → 工具轮是成功的一轮；
 * 没给工具还收到工具调用 → 照旧是交付不了译文的失败。
 */
describe("KA-4 工具轮是不是错误，取决于调用方给没给工具", () => {
  const toolTurn = {
    type: "done",
    message: {
      content: [
        { type: "thinking", thinking: "想", thinkingSignature: "SIG" },
        { type: "toolCall", id: "call_1", name: "register_terms", arguments: { terms: [], voices: [] } },
      ],
      usage,
      stopReason: "toolUse",
      rawStopReason: "completed",
    },
  };
  const tools = [{ name: "register_terms", description: "d", parameters: { type: "object" } }] as never;

  test("给了工具时正常返回，工具调用与续接句柄都在结果里", async () => {
    hooks.respond = () => [toolTurn];
    const result = await runtime().complete("fake/m", [{ role: "user", content: "x" }], { tools, retry: { maxRetries: 0 } });

    expect(result.text).toBe("");
    expect(result.toolCalls?.[0]?.name).toBe("register_terms");
    // 续接句柄必须原样带出：推理签名在 thinkingSignature 里，第二轮回灌全靠它
    expect(result.continuation?.content).toHaveLength(2);
    expect(result.stopReason).toBe("toolUse");
  });

  test("没给工具却收到工具调用 → 仍是 tool_call_only 失败", async () => {
    hooks.respond = () => [toolTurn];
    let thrown: unknown;
    try {
      await runtime().complete("fake/m", [{ role: "user", content: "x" }], { retry: { maxRetries: 0 } });
    } catch (error) { thrown = error; }
    expect((thrown as { shapeKind?: string })?.shapeKind).toBe("tool_call_only");
  });

  test("给了工具但只是普通空响应（无工具调用） → 照旧失败，不许被这条口子放过", async () => {
    hooks.respond = () => [{ type: "done", message: { content: [{ type: "thinking", thinking: "…" }], usage, stopReason: "stop" } }];
    let thrown: unknown;
    try {
      await runtime().complete("fake/m", [{ role: "user", content: "x" }], { tools, thinking: "off", retry: { maxRetries: 0 } });
    } catch (error) { thrown = error; }
    expect((thrown as { shapeKind?: string })?.shapeKind).toBe("empty_response");
  });

  test("给了工具但没正常结束（stopReason=length） → 仍是 incomplete，切批的退路不能被吞掉", async () => {
    hooks.respond = () => [{
      type: "done",
      message: { content: [{ type: "toolCall", id: "c1", name: "register_terms", arguments: {} }], usage, stopReason: "length" },
    }];
    let thrown: unknown;
    try {
      await runtime().complete("fake/m", [{ role: "user", content: "x" }], { tools, thinking: "off", retry: { maxRetries: 0 } });
    } catch (error) { thrown = error; }
    expect((thrown as { shapeKind?: string })?.shapeKind).toBe("incomplete");
  });
});

describe("KA-2 内容块的语义不许被 join 抹平", () => {
  test("被安全过滤器删除的思考不混进 reasoning，而是单独计数", async () => {
    hooks.respond = () => [{
      type: "done",
      message: {
        content: [
          { type: "thinking", thinking: "正常思考" },
          { type: "thinking", thinking: "", thinkingSignature: "SEALED", redacted: true },
          { type: "text", text: "译文" },
        ],
        usage,
        stopReason: "stop",
      },
    }];
    const result = await runtime().complete("fake/m", [{ role: "user", content: "x" }], { retry: { maxRetries: 0 } });
    // 一段被删除的思考此前和真实思考 join 在一起，界面上分不出来
    expect(result.reasoning).toBe("正常思考");
    expect(result.reasoningRedacted).toBe(1);
  });

  test("thinking_end 有独立信号（渲染层才分得清「块结束」与「还在想」）", async () => {
    hooks.respond = () => [
      { type: "thinking_start", contentIndex: 0 },
      { type: "thinking_delta", contentIndex: 0, delta: "想" },
      { type: "thinking_end", contentIndex: 0, content: "想" },
      textDone,
    ];
    const ends: number[] = [];
    await runtime().complete("fake/m", [{ role: "user", content: "x" }], {
      retry: { maxRetries: 0 },
      onThinking: () => {},
      onThinkingEnd: (index) => ends.push(index),
    });
    expect(ends).toEqual([0]);
  });

  test("工具调用期间有进度信号（轮 1 全靠工具参数交付，不能是黑屏）", async () => {
    hooks.respond = () => [
      { type: "toolcall_start", contentIndex: 0 },
      { type: "toolcall_delta", contentIndex: 0, delta: '{"terms"' },
      { type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "c1", name: "register_terms", arguments: { terms: [] } } },
      textDone,
    ];
    const phases: string[] = [];
    await runtime().complete("fake/m", [{ role: "user", content: "x" }], {
      retry: { maxRetries: 0 },
      onToolCall: (event) => phases.push(event.phase),
    });
    expect(phases).toEqual(["start", "delta", "end"]);
  });
});

describe("KA-2 用量与诊断", () => {
  test("cacheWrite1h 接住（Anthropic 系上报的长驻缓存写入）", async () => {
    hooks.respond = () => [{ type: "done", message: { content: [{ type: "text", text: "译文" }], usage: { ...usage, cacheWrite: 500, cacheWrite1h: 200 }, stopReason: "stop" } }];
    const result = await runtime().complete("fake/m", [{ role: "user", content: "x" }], { retry: { maxRetries: 0 } });
    expect(result.usage?.cacheWrite1h).toBe(200);
  });

  test("diagnostics 接住，但 details 与 stack 一律丢弃（红线：可能夹带提示词片段）", async () => {
    hooks.respond = () => [{
      type: "done",
      message: {
        content: [{ type: "text", text: "译文" }],
        usage,
        stopReason: "stop",
        diagnostics: [{
          type: "retry",
          timestamp: 1,
          error: { name: "TypeError", message: "boom", code: 500, stack: "at /home/u/secret.ts:1" },
          details: { requestBody: "……原文全文……" },
        }],
      },
    }];
    const result = await runtime().complete("fake/m", [{ role: "user", content: "x" }], { retry: { maxRetries: 0 } });
    expect(result.diagnostics).toEqual([{ type: "retry", timestamp: 1, name: "TypeError", message: "boom", code: 500 }]);
    const serialized = JSON.stringify(result.diagnostics);
    expect(serialized).not.toContain("原文全文");
    expect(serialized).not.toContain("secret.ts");
  });
});

describe("KA-2 strict 模式开关真的接到了 pi", () => {
  test("supportsStrictMode 经 Model.compat 传下去（配了却不接通，等于把失败推迟到运行时）", async () => {
    await runtime([{ id: "m", supportsStrictMode: true }]).complete("fake/m", [{ role: "user", content: "x" }], { retry: { maxRetries: 0 } });
    expect((hooks.models[0] as { compat?: { supportsStrictMode?: boolean } })?.compat?.supportsStrictMode).toBe(true);
  });

  test("没配时 compat 缺席，不编一个默认值（pi 自己有 API 相关的默认）", async () => {
    await runtime([{ id: "m" }]).complete("fake/m", [{ role: "user", content: "x" }], { retry: { maxRetries: 0 } });
    expect((hooks.models[0] as { compat?: unknown })?.compat).toBeUndefined();
  });
});
