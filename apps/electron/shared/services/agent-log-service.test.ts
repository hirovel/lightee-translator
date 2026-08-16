/**
 * R0-2：Agent 调用日志服务对 usage 的透传。
 *
 * 逐条 usage 是「缓存到底命中没有」的唯一证据；总量只能回答「这一轮花了多少」，
 * 回答不了「哪一次调用打穿了前缀」。因此 list 与 read 都必须带。
 */
import { describe, expect, it } from "vitest";
import { AgentLogService } from "./agent-log-service.js";
import type { LlmBridge, LlmCallLogEntry } from "../llm-types.js";
import type { ServiceContext } from "./service-context.js";

function entry(overrides: Partial<LlmCallLogEntry> = {}): LlmCallLogEntry {
  return {
    id: "llm-1",
    label: "translator",
    model: "deepseek/chat",
    thinking: "low",
    ok: true,
    prompt: "系统提示 + 原文",
    response: "译文",
    reasoning: "思考",
    ms: 1200,
    ts: 1_700_000_000_000,
    usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 40 },
    ...overrides,
  };
}

function serviceWith(entries: LlmCallLogEntry[], totals?: { input: number; output: number; cacheRead: number; cacheWrite: number }) {
  const llm: LlmBridge = {
    complete: async () => ({ text: "" }),
    getCallLog: () => entries,
    getCallLogById: (id: string) => entries.find((e) => e.id === id),
    ...(totals ? { getTokenTotals: () => totals } : {}),
  };
  return new AgentLogService({ llm, isDev: true } as unknown as ServiceContext);
}

describe("AgentLogService 按书过滤（控制台不是全局流水账）", () => {
  function serviceWithBooks(memory: LlmCallLogEntry[], history: LlmCallLogEntry[]) {
    const llm: LlmBridge = {
      complete: async () => ({ text: "" }),
      getCallLog: () => memory,
      getCallLogById: (id: string) => memory.find((e) => e.id === id),
      getHistory: async () => history,
    };
    return new AgentLogService({ llm, isDev: true } as unknown as ServiceContext);
  }

  it("带 workspaceId 时只列这本书的调用——另一本书的记录一条不混进来", async () => {
    const bookA = entry({ id: "llm-a", ts: 3, workspaceId: "ws-a" });
    const bookB = entry({ id: "llm-b", ts: 2, workspaceId: "ws-b" });
    const result = await serviceWithBooks([bookA], [bookB]).agentLogList({ limit: 30, workspaceId: "ws-a" });
    const value = (result as { value: { entries: Array<{ id: string }> } }).value;
    expect(value.entries.map((e) => e.id)).toEqual(["llm-a"]);
  });

  it("没有工作区戳的旧记录不出现在任何书的视图里——「可能是这本书的」比列表短更糟", async () => {
    const legacy = entry({ id: "llm-legacy", ts: 5 });
    const mine = entry({ id: "llm-mine", ts: 4, workspaceId: "ws-a" });
    const result = await serviceWithBooks([], [legacy, mine]).agentLogList({ limit: 30, workspaceId: "ws-a" });
    const value = (result as { value: { entries: Array<{ id: string }> } }).value;
    expect(value.entries.map((e) => e.id)).toEqual(["llm-mine"]);
  });

  it("不带 workspaceId 保持全量（历史/调试入口的旧行为不变）", async () => {
    const bookA = entry({ id: "llm-a", ts: 3, workspaceId: "ws-a" });
    const legacy = entry({ id: "llm-legacy", ts: 2 });
    const result = await serviceWithBooks([bookA], [legacy]).agentLogList({ limit: 30 });
    const value = (result as { value: { entries: Array<{ id: string }> } }).value;
    expect(value.entries.map((e) => e.id)).toEqual(["llm-a", "llm-legacy"]);
  });

  it("过滤不吃配额：别的书占满最近 N 条时，这本书的记录仍然列得出来", async () => {
    const noise = Array.from({ length: 40 }, (_, i) => entry({ id: `llm-noise-${i}`, ts: 1000 + i, workspaceId: "ws-b" }));
    const mine = entry({ id: "llm-mine", ts: 1, workspaceId: "ws-a" });
    const result = await serviceWithBooks([], [...noise, mine]).agentLogList({ limit: 30, workspaceId: "ws-a" });
    const value = (result as { value: { entries: Array<{ id: string }> } }).value;
    expect(value.entries.map((e) => e.id)).toEqual(["llm-mine"]);
  });
});

describe("AgentLogService 跨运行历史（重启后记录不该看起来像没了）", () => {
  /** 内存缓冲空（刚重启），历史文件里有记录 */
  function serviceWithHistory(memory: LlmCallLogEntry[], history: LlmCallLogEntry[], historyFails = false) {
    const llm: LlmBridge = {
      complete: async () => ({ text: "" }),
      getCallLog: () => memory,
      getCallLogById: (id: string) => memory.find((e) => e.id === id),
      getHistory: async () => { if (historyFails) throw new Error("历史文件读不到"); return history; },
    };
    return new AgentLogService({ llm, isDev: true } as unknown as ServiceContext);
  }

  it("内存缓冲空时列表回落到持久化历史——重启前的调用照样看得见", async () => {
    const old = entry({ id: "llm-old", ts: 1_600_000_000_000 });
    const result = await serviceWithHistory([], [old]).agentLogList({ limit: 30 });
    const value = (result as { value: { entries: Array<{ id: string }> } }).value;
    expect(value.entries.map((e) => e.id)).toEqual(["llm-old"]);
  });

  it("两边合并按时间新→旧，同 id 以内存那份为准（不重复出现）", async () => {
    const shared = entry({ id: "llm-2", ts: 1_700_000_000_000, response: "内存版" });
    const staleCopy = entry({ id: "llm-2", ts: 1_700_000_000_000, response: "历史版" });
    const older = entry({ id: "llm-1", ts: 1_600_000_000_000 });
    const newer = entry({ id: "llm-3", ts: 1_800_000_000_000 });
    const result = await serviceWithHistory([shared, newer], [staleCopy, older]).agentLogList({ limit: 30 });
    const value = (result as { value: { entries: Array<{ id: string; responsePreview: string }> } }).value;
    expect(value.entries.map((e) => e.id)).toEqual(["llm-3", "llm-2", "llm-1"]);
    expect(value.entries[1]?.responsePreview).toBe("内存版");
  });

  it("点开旧记录：内存里没有就翻历史，仍拿得到完整 prompt/response", async () => {
    const old = entry({ id: "llm-old", prompt: "很久以前的提示词", response: "很久以前的译文" });
    const result = await serviceWithHistory([], [old]).agentLogRead({ id: "llm-old" });
    expect(result.ok).toBe(true);
    const value = (result as { value: { prompt: string; response: string } }).value;
    expect(value.prompt).toBe("很久以前的提示词");
    expect(value.response).toBe("很久以前的译文");
  });

  it("历史文件读不到 → 退回只有内存那部分，整张表不该因此打不开", async () => {
    const live = entry({ id: "llm-live" });
    const result = await serviceWithHistory([live], [], true).agentLogList({ limit: 30 });
    expect(result.ok).toBe(true);
    const value = (result as { value: { entries: Array<{ id: string }> } }).value;
    expect(value.entries.map((e) => e.id)).toEqual(["llm-live"]);
  });
});

describe("AgentLogService usage 透传（R0-2）", () => {
  it("list 的每条记录带四字段 usage", async () => {
    const result = await serviceWith([entry()]).agentLogList({ limit: 30 });
    expect(result.ok).toBe(true);
    const value = (result as { value: { entries: Array<{ usage?: unknown }> } }).value;
    expect(value.entries[0]?.usage).toEqual({ input: 100, output: 20, cacheRead: 300, cacheWrite: 40 });
  });

  it("read 的详情带 usage", async () => {
    const result = await serviceWith([entry()]).agentLogRead({ id: "llm-1" });
    expect(result.ok).toBe(true);
    const value = (result as { value: { usage?: unknown } }).value;
    expect(value.usage).toEqual({ input: 100, output: 20, cacheRead: 300, cacheWrite: 40 });
  });

  it("旧记录无 usage → 字段缺席而不是伪造 0", async () => {
    const withoutUsage = entry({ usage: undefined });
    const result = await serviceWith([withoutUsage]).agentLogList({ limit: 30 });
    const value = (result as { value: { entries: Array<{ usage?: unknown }> } }).value;
    expect(value.entries[0]?.usage).toBeUndefined();
  });

  it("桥不提供 totals → 兜底四字段全 0（含 cacheWrite）", async () => {
    const result = await serviceWith([entry()]).agentLogList({ limit: 30 });
    const value = (result as { value: { totals: unknown } }).value;
    expect(value.totals).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("桥提供 totals → 原样透传 cacheWrite", async () => {
    const totals = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
    const result = await serviceWith([entry()], totals).agentLogList({ limit: 30 });
    const value = (result as { value: { totals: unknown } }).value;
    expect(value.totals).toEqual(totals);
  });
});
