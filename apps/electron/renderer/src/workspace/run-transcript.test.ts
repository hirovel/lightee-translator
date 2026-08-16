import { describe, expect, it } from "vitest";
import { currentActivity, emptyTranscript, reduceTranscript, type TranscriptEvent, type TranscriptState } from "./run-transcript.js";

/** 按顺序喂事件，时刻由调用方给（纯函数不读时钟） */
function feed(events: Array<[TranscriptEvent, number]>, from: TranscriptState = emptyTranscript()): TranscriptState {
  return events.reduce((state, [event, at]) => reduceTranscript(state, event, at), from);
}

const started: TranscriptEvent = { type: "chapter.stateChanged", chapterId: "ch001", to: "translating" };

describe("运行流水：开工与归属", () => {
  it("translating 是开工信号，流水从这里起算", () => {
    const state = feed([[started, 1000]]);
    expect(state.chapterId).toBe("ch001");
    expect(state.startedAt).toBe(1000);
    expect(state.steps.map((s) => s.title)).toEqual(["开始翻译"]);
    expect(state.steps[0]!.at).toBe(0);
  });

  it("开工之前的事件一概不收——没有归属的步骤挂不到任何一章上", () => {
    const state = feed([[{ type: "review.progress", chapterId: "ch001", message: "开始审校" }, 500]]);
    expect(state.steps).toEqual([]);
  });

  it("别的章的事件不混进来", () => {
    const state = feed([
      [started, 1000],
      [{ type: "review.progress", chapterId: "ch002", message: "别的章" }, 1100],
    ]);
    expect(state.steps).toHaveLength(1);
  });

  it("换章即重开——跨章粘在一起会让「历时」变成假数", () => {
    const state = feed([
      [started, 1000],
      [{ type: "review.progress", chapterId: "ch001", message: "审校" }, 1100],
      [{ type: "chapter.stateChanged", chapterId: "ch002", to: "translating" }, 5000],
    ]);
    expect(state.chapterId).toBe("ch002");
    expect(state.startedAt).toBe(5000);
    expect(state.steps).toHaveLength(1);
  });
});

describe("运行流水：思考块攒成一格", () => {
  const think = (delta: string, done?: boolean): TranscriptEvent =>
    ({ type: "agent.thinking", label: "translate:ch001", attempt: 1, thinking: "high", delta, ...(done ? { done } : {}) });

  it("增量流只占一格，字数累加，不是每条一行", () => {
    const state = feed([[started, 0], [think("abc"), 100], [think("de"), 200], [think("f"), 300]]);
    const blocks = state.steps.filter((s) => s.kind === "thinking");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.detail).toContain("6 字");
    expect(blocks[0]!.running).toBe(true);
  });

  it("done 到达后停止转圈并写上历时", () => {
    const state = feed([[started, 0], [think("abcd"), 100], [think("", true), 900]]);
    const block = state.steps.find((s) => s.kind === "thinking")!;
    expect(block.running).toBe(false);
    expect(block.detail).toContain("历时 800ms");
  });

  it("没收到 done 就一直标着运行中——不把未闭合的块假装成完成的", () => {
    const state = feed([[started, 0], [think("abc"), 100]]);
    expect(state.steps.find((s) => s.kind === "thinking")!.running).toBe(true);
  });

  it("换 attempt 即换块（重试的思考不该和上一次粘在一起）", () => {
    const state = feed([
      [started, 0],
      [think("aaa"), 100], [think("", true), 200],
      [{ type: "agent.thinking", label: "translate:ch001", attempt: 2, thinking: "high", delta: "bbb" }, 300],
    ]);
    expect(state.steps.filter((s) => s.kind === "thinking")).toHaveLength(2);
  });
});

describe("运行流水：工具轮交接标成推定，不写成事实", () => {
  it("两个思考块之间的间隔单列一格，并且写明它是推定的", () => {
    const t = (attempt: number, delta: string, done?: boolean): TranscriptEvent =>
      ({ type: "agent.thinking", label: "translate:ch001", attempt, thinking: "high", delta, ...(done ? { done } : {}) });
    const state = feed([
      [started, 0],
      [t(1, "轮一思考"), 100], [t(1, "", true), 5000],
      [t(1, "轮二思考"), 8000],
    ]);
    const gap = state.steps.find((s) => s.kind === "gap");
    expect(gap).toBeDefined();
    expect(gap!.detail).toContain("3000ms");
    // 判据：这一步**没有专属事件**，措辞必须让读的人知道它是算出来的
    expect(gap!.detail).toContain("推定");
  });

  it("第一个思考块之前不画间隔（没有「上一块」可比）", () => {
    const state = feed([[started, 0], [{ type: "agent.thinking", label: "t", delta: "x" }, 100]]);
    expect(state.steps.some((s) => s.kind === "gap")).toBe(false);
  });
});

describe("运行流水：只收有信息量的事件", () => {
  it("agent.status 只收告警——running/done 与状态迁移是同一件事，画两遍是噪音", () => {
    const state = feed([
      [started, 0],
      [{ type: "agent.status", agent: "translator", status: "running" }, 100],
      [{ type: "agent.status", agent: "translator", status: "done", kind: "warning", message: "提取哑火" }, 200],
    ]);
    const warns = state.steps.filter((s) => s.kind === "warning");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.detail).toBe("提取哑火");
  });

  it("translate.progress 的 0% 与 translating 重复，不画", () => {
    const state = feed([[started, 0], [{ type: "translate.progress", chapterId: "ch001", progress: 0, message: "开始翻译" }, 50]]);
    expect(state.steps).toHaveLength(1);
  });

  it("状态迁移的 reason 若只是「a -> b」就不当副行显示（那是机器话）", () => {
    const state = feed([[started, 0], [{ type: "chapter.stateChanged", chapterId: "ch001", to: "translated", reason: "translating -> translated" }, 100]]);
    expect(state.steps.at(-1)!.detail).toBeUndefined();
  });

  it("stuck 的原因是给人看的，要显示", () => {
    const state = feed([[started, 0], [{ type: "chapter.stateChanged", chapterId: "ch001", to: "stuck", reason: "需要作者处理：dialogue_format" }, 100]]);
    expect(state.steps.at(-1)!.detail).toContain("需要作者处理");
  });
});

describe("运行流水：终态", () => {
  it("approved → done 且流水结束", () => {
    const state = feed([[started, 0], [{ type: "chapter.stateChanged", chapterId: "ch001", to: "approved" }, 100]]);
    expect(state.finished).toBe(true);
    expect(state.steps.at(-1)!.kind).toBe("done");
    expect(currentActivity(state)).toEqual({ text: "ch001 · 已定稿", running: false });
  });

  it("stuck → failed 且流水结束", () => {
    const state = feed([[started, 0], [{ type: "chapter.stateChanged", chapterId: "ch001", to: "stuck" }, 100]]);
    expect(state.finished).toBe(true);
    expect(state.steps.at(-1)!.kind).toBe("failed");
  });

  it("跑动中 currentActivity 标 running", () => {
    const state = feed([[started, 0], [{ type: "agent.thinking", label: "t", delta: "x" }, 100]]);
    expect(currentActivity(state)?.running).toBe(true);
  });

  it("没开工时没有活动可报", () => {
    expect(currentActivity(emptyTranscript())).toBeNull();
  });
});
