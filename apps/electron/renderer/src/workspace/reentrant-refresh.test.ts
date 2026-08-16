/**
 * 这组测试守的是一次真实事故：导出面板一点开，整个应用卡死。
 *
 * 面板刷新写 DOM → MutationObserver 惊醒 → 再刷新 → 再写 DOM，同步递归，
 * 主线程再也回不来。断环必须是结构性的，不能靠「记得每次写入都先比一次旧值」。
 */
import { describe, expect, it, vi } from "vitest";
import { createReentrantRefresh } from "./reentrant-refresh.js";

/** 手动泵：把 schedule 收到的回调攒起来，由测试决定什么时候跑 */
function manualScheduler() {
  const queued: Array<() => void> = [];
  return {
    schedule: (fn: () => void) => { queued.push(fn); },
    /** 跑完当前排队的（跑的过程中新排进来的留到下一次 drain） */
    drain(): number {
      const batch = queued.splice(0);
      for (const fn of batch) fn();
      return batch.length;
    },
    get pending(): number { return queued.length; },
  };
}

describe("createReentrantRefresh", () => {
  it("刷新过程中自己惊动自己：不递归，只在跑完后补一轮", () => {
    const pump = manualScheduler();
    let calls = 0;
    let trigger: () => void = () => {};
    trigger = createReentrantRefresh(() => {
      calls += 1;
      // 模拟「刷新写 DOM → 观察者立刻回调」——这一步从前就是死循环的入口
      trigger();
      trigger();
    }, { schedule: pump.schedule });

    trigger();
    expect(calls).toBe(1);        // 同步递归被掐断
    expect(pump.pending).toBe(1); // 只补一轮，不是补两轮

    pump.drain();
    expect(calls).toBe(2);
    expect(pump.pending).toBe(1); // 第二轮又自惊动一次 → 还会补
  });

  it("一轮里惊动一百次，也只折叠成一次补跑", () => {
    const pump = manualScheduler();
    let trigger: () => void = () => {};
    let calls = 0;
    trigger = createReentrantRefresh(() => {
      calls += 1;
      if (calls === 1) for (let i = 0; i < 100; i += 1) trigger();
    }, { schedule: pump.schedule });

    trigger();
    expect(calls).toBe(1);
    expect(pump.pending).toBe(1);
    pump.drain();
    expect(calls).toBe(2);
    expect(pump.pending).toBe(0); // 第二轮安静 → 收敛
  });

  it("异步刷新期间的触发也只折叠成一次，且要等这一轮真的结束", async () => {
    const pump = manualScheduler();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn(() => gate);
    const trigger = createReentrantRefresh(run, { schedule: pump.schedule });

    trigger();
    trigger();
    trigger();
    expect(run).toHaveBeenCalledTimes(1);
    expect(pump.pending).toBe(0); // 还没跑完，补跑不该提前排上

    release();
    await gate;
    await Promise.resolve();
    expect(pump.pending).toBe(1);
    pump.drain();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("run 抛错不会把触发器永久卡住——那等于面板从此不再刷新", () => {
    const pump = manualScheduler();
    const run = vi.fn(() => { throw new Error("boom"); });
    const trigger = createReentrantRefresh(run, { schedule: pump.schedule });

    expect(() => trigger()).not.toThrow();
    trigger();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("异步 run 被拒绝同样不卡住", async () => {
    const pump = manualScheduler();
    const run = vi.fn(() => Promise.reject(new Error("boom")));
    const trigger = createReentrantRefresh(run, { schedule: pump.schedule });

    trigger();
    await Promise.resolve();
    await Promise.resolve();
    trigger();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("shouldRun 说不跑就一次都不跑", () => {
    const run = vi.fn();
    const trigger = createReentrantRefresh(run, { schedule: () => {}, shouldRun: () => false });
    trigger();
    trigger();
    expect(run).not.toHaveBeenCalled();
  });
});
