/**
 * TR-03：思考增量从主进程流到渲染层。
 *
 * 直连是不行的——`thinking_delta` 是逐小块到达的，一次翻译几万字符思考意味着
 * 上万条 IPC 消息。所以中间要有个攒批的缓冲：按时间窗与体积双阈值合并，
 * 到点才发一条。
 *
 * 这里测的是缓冲本身（纯函数 + 注入时钟），不碰 Electron。
 */
import { describe, expect, it, vi } from "vitest";
import { ThinkingBuffer } from "./thinking-stream.js";

function harness(overrides: { windowMs?: number; maxChars?: number } = {}) {
  const flushed: Array<{ text: string; done: boolean }> = [];
  const buffer = new ThinkingBuffer((text, done) => flushed.push({ text, done }), overrides);
  return { buffer, flushed };
}

describe("ThinkingBuffer 攒批", () => {
  it("窗口内的多个 delta 合成一条发出，而不是逐块轰炸 IPC", () => {
    vi.useFakeTimers();
    const { buffer, flushed } = harness({ windowMs: 80 });
    buffer.push("先看");
    buffer.push("人名");
    buffer.push("读法");
    expect(flushed).toHaveLength(0); // 窗口未到，一条都不发
    vi.advanceTimersByTime(80);
    expect(flushed).toEqual([{ text: "先看人名读法", done: false }]);
    vi.useRealTimers();
  });

  it("攒够体积就立刻发，不等窗口——长思考不该卡住整整一个窗口才露面", () => {
    vi.useFakeTimers();
    const { buffer, flushed } = harness({ windowMs: 10_000, maxChars: 5 });
    buffer.push("一二三");
    buffer.push("四五六");
    expect(flushed).toEqual([{ text: "一二三四五六", done: false }]);
    vi.useRealTimers();
  });

  it("finish 把尾巴冲出去并标记结束——否则最后不足一窗的思考永远出不来", () => {
    vi.useFakeTimers();
    const { buffer, flushed } = harness({ windowMs: 80 });
    buffer.push("尾巴");
    buffer.finish();
    expect(flushed).toEqual([{ text: "尾巴", done: true }]);
    vi.useRealTimers();
  });

  it("没有待发内容时 finish 仍报一次结束——渲染层靠它把打字机停下", () => {
    vi.useFakeTimers();
    const { buffer, flushed } = harness({ windowMs: 80 });
    buffer.finish();
    expect(flushed).toEqual([{ text: "", done: true }]);
    vi.useRealTimers();
  });

  it("finish 之后再 push 一律丢弃——迟到的 delta 不该复活一个已经结束的块", () => {
    vi.useFakeTimers();
    const { buffer, flushed } = harness({ windowMs: 80 });
    buffer.finish();
    buffer.push("迟到");
    vi.advanceTimersByTime(1000);
    expect(flushed).toHaveLength(1);
    vi.useRealTimers();
  });

  it("finish 会清掉待触发的定时器——留着它会让进程迟迟不退出", () => {
    vi.useFakeTimers();
    const { buffer } = harness({ windowMs: 80 });
    buffer.push("x");
    buffer.finish();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("下游抛异常不能带垮它——展示层的 bug 不该让翻译失败", () => {
    vi.useFakeTimers();
    const buffer = new ThinkingBuffer(() => { throw new Error("渲染层炸了"); }, { windowMs: 80 });
    buffer.push("x");
    expect(() => vi.advanceTimersByTime(80)).not.toThrow();
    expect(() => buffer.finish()).not.toThrow();
    vi.useRealTimers();
  });
});
