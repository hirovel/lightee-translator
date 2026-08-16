/**
 * TR-01 / TR-02：思考块既要**流出去**给人看，也要**留下来**供事后溯源。
 *
 * 现状是两处都缺：
 *
 * 1. `thinking_delta` 事件已经在收（llm-runtime.ts 用它算 TTFT），但 delta 内容
 *    当场丢弃。用户面前只有一个转圈的秒表，看不到模型正在干什么。
 * 2. `pushCallLog` 每次**逻辑调用**只写一次（终局那一次）。降档途中废掉的尝试，
 *    思考内容一个字都不落盘——全库 596 条历史里「失败且带思考内容」的条目是 **0**。
 *    2026-08-12 的诊断因此只能靠一条侥幸成功的样本（思考 13447 字符、正文 174 字符）
 *    去推断那四次失败发生了什么。
 *
 * 红线：思考块含原文与译文草稿。它可以进 llm-history.jsonl（本就存全文 prompt/response），
 * **不得**进 usage.jsonl（只记 reasoningChars 长度）与 AppLog。
 */
import { describe, expect, test, beforeEach, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  respond: (_thinking: string | undefined) => [] as unknown[],
}));

vi.mock("@earendil-works/pi-ai", () => ({
  lazyApi: (fn: unknown) => fn,
  createProvider: (cfg: { models?: Array<{ id: string }> }) => ({
    getModels: () => cfg.models ?? [],
    streamSimple: (_model: unknown, _context: unknown, opts: { reasoning?: string }) => {
      const events = hooks.respond(opts.reasoning);
      return (async function* () { for (const event of events) yield event; })();
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

/** 一次带思考流的正常调用：思考分三块吐出，然后是正文 */
const thinkingThenText = [
  { type: "thinking_start", contentIndex: 0 },
  { type: "thinking_delta", contentIndex: 0, delta: "先看" },
  { type: "thinking_delta", contentIndex: 0, delta: "人名" },
  { type: "thinking_delta", contentIndex: 0, delta: "读法" },
  { type: "thinking_end", contentIndex: 0, content: "先看人名读法" },
  { type: "text_delta", contentIndex: 1, delta: "译文" },
  { type: "done", message: { content: [{ type: "thinking", thinking: "先看人名读法" }, { type: "text", text: "译文" }], usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" } },
];

/**
 * 正常结束但只有思考没有正文（empty_response）——降档梯子会重来一次。
 * 注意 stopReason 必须是 "stop"：TR-12 起 "length"（未正常结束）是终态，
 * 不再进梯子，这组测试要的是**跨尝试**的思考流与落盘行为。
 */
const thinkingOnly = [
  { type: "thinking_delta", contentIndex: 0, delta: "反复推敲" },
  { type: "done", message: { content: [{ type: "thinking", thinking: "反复推敲" }], usage: { input: 10, output: 8192, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" } },
];

beforeEach(() => {
  hooks.respond = () => thinkingThenText;
  LlmRuntime.resetThinkingMemory();
});

describe("TR-01 思考块流式外发", () => {
  test("每个 thinking_delta 都回调出去——拼起来就是完整思考", async () => {
    const seen: string[] = [];
    const result = await runtime().complete("fake/m", [{ role: "user", content: "x" }], {
      thinking: "low",
      onThinking: (delta) => seen.push(delta),
      retry: { maxRetries: 0 },
    });
    expect(seen).toEqual(["先看", "人名", "读法"]);
    expect(seen.join("")).toBe(result.reasoning);
  });

  test("降档重试时后一次尝试的思考照样流出——用户看见的是**正在发生**的那一次", async () => {
    hooks.respond = (thinking) => (thinking === "high" ? thinkingThenText : thinkingOnly);
    const seen: string[] = [];
    await runtime().complete("fake/m", [{ role: "user", content: "x" }], {
      thinking: "max",
      onThinking: (delta) => seen.push(delta),
      retry: { maxRetries: 0 },
    });
    // max、xhigh 各废掉一次，high 成功；三次的思考都要流出来
    expect(seen).toEqual(["反复推敲", "反复推敲", "先看", "人名", "读法"]);
  });

  test("回调自己抛异常不能带垮调用——展示层的 bug 不该让翻译失败", async () => {
    const result = await runtime().complete("fake/m", [{ role: "user", content: "x" }], {
      thinking: "low",
      onThinking: () => { throw new Error("渲染层炸了"); },
      retry: { maxRetries: 0 },
    });
    expect(result.text).toBe("译文");
  });

  test("不传 onThinking 时一切照旧（回调是可选能力，不是必需装配）", async () => {
    const result = await runtime().complete("fake/m", [{ role: "user", content: "x" }], { thinking: "low", retry: { maxRetries: 0 } });
    expect(result.text).toBe("译文");
    expect(result.reasoning).toBe("先看人名读法");
  });
});

describe("TR-02 逐尝试落盘", () => {
  test("降档路上每一次尝试各写一条日志，思考内容完整保留", async () => {
    hooks.respond = (thinking) => (thinking === "high" ? thinkingThenText : thinkingOnly);
    const llm = runtime();
    await llm.complete("fake/m", [{ role: "user", content: "x" }], { thinking: "max", retry: { maxRetries: 0 } });

    const log = llm.getCallLog(10);
    // max 废 / xhigh 废 / high 成 —— 三次尝试三条，而不是只有终局那一条
    expect(log).toHaveLength(3);
    const failed = log.filter((e) => !e.ok);
    expect(failed).toHaveLength(2);
    // 关键：失败那两条也带着思考内容。此前它们在所有记录里只剩一排 0
    expect(failed.every((e) => e.reasoning === "反复推敲")).toBe(true);
    expect(failed.every((e) => e.usage?.output === 8192)).toBe(true);
  });

  test("每条日志标出自己是第几次尝试，且档位是**那一次**的档位", async () => {
    hooks.respond = (thinking) => (thinking === "high" ? thinkingThenText : thinkingOnly);
    const llm = runtime();
    await llm.complete("fake/m", [{ role: "user", content: "x" }], { thinking: "max", retry: { maxRetries: 0 } });

    // getCallLog 返回倒序（最新在前），按 attempt 排回去
    const log = llm.getCallLog(10).slice().sort((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0));
    expect(log.map((e) => e.attempt)).toEqual([1, 2, 3]);
    // 记请求档位会让「用户选了 max」与「降到 high 才成」长得一样——记生效档位
    expect(log.map((e) => e.thinking)).toEqual(["max", "xhigh", "high"]);
  });

  test("一次就成时只有一条，不制造噪音", async () => {
    const llm = runtime();
    await llm.complete("fake/m", [{ role: "user", content: "x" }], { thinking: "low", retry: { maxRetries: 0 } });
    expect(llm.getCallLog(10)).toHaveLength(1);
  });
});
