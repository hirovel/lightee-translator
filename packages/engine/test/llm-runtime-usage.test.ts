/**
 * R0-2 缓存可观测：usage 从 pi-ai 到调用日志、历史文件与累计计数的全链路透传。
 *
 * 用假 provider 顶替 pi-ai，直接构造带 cacheRead/cacheWrite 的 done 事件——
 * 真实服务商的缓存字段无法在单测里稳定复现，而这里要验的是「拿到了就不丢」。
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hooks = vi.hoisted(() => ({
  usage: undefined as unknown,
}));

vi.mock("@earendil-works/pi-ai", () => ({
  lazyApi: (fn: unknown) => fn,
  createProvider: (cfg: { models?: Array<{ id: string }> }) => ({
    getModels: () => cfg.models ?? [],
    streamSimple: () =>
      (async function* () {
        yield {
          type: "done",
          message: { content: [{ type: "text", text: "译文" }], usage: hooks.usage, stopReason: "stop" },
        };
      })(),
  }),
}));

const { LlmRuntime } = await import("../src/llm-runtime.ts");
type LlmCallLogEntry = import("../src/llm-runtime.ts").LlmCallLogEntry;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "lightee-usage-"));
}

function runtime(historyFile: string | false) {
  return LlmRuntime.create({
    configDir: "C:/nonexistent-lightee-config",
    historyFile,
    providers: { fake: { name: "fake", apiKey: "k", models: [{ id: "m" }] } },
  });
}

/**
 * pi-ai 的 Usage 形态。
 *
 * TR-11 之前这里写着「cost 字段本层不消费」，而下面三条断言恰好把「只取四个字段」
 * 钉死了——注释与断言一起把丢弃 reasoning / totalTokens / cost 变成了「预期行为」。
 * 服务商上报的推理 token 数与算好的成本一直在这个结构里，接住它们是本来就该做的事。
 */
function usageOf(input: number, output: number, cacheRead: number, cacheWrite: number) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

beforeEach(() => {
  hooks.usage = usageOf(100, 20, 300, 40);
});

describe("R0-2 usage 透传", () => {
  test("complete 返回的 usage 保留 cacheWrite", async () => {
    const llm = runtime(false);
    const result = await llm.complete("fake/m", [{ role: "user", content: "x" }], { retry: { maxRetries: 0 } });
    expect(result.usage).toEqual({ input: 100, output: 20, cacheRead: 300, cacheWrite: 40, totalTokens: 460, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  });

  test("调用日志条目带四字段 usage", async () => {
    const llm = runtime(false);
    await llm.complete("fake/m", [{ role: "user", content: "x" }], { retry: { maxRetries: 0 } });
    const [entry] = llm.getCallLog();
    expect(entry?.usage).toEqual({ input: 100, output: 20, cacheRead: 300, cacheWrite: 40, totalTokens: 460, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  });

  test("历史 JSONL 条目带 usage（成本分析看得见缓存维度）", async () => {
    const dir = tempDir();
    const historyPath = join(dir, "llm-history.jsonl");
    const llm = runtime(historyPath);
    await llm.complete("fake/m", [{ role: "user", content: "x" }], { retry: { maxRetries: 0 } });

    const line = readFileSync(historyPath, "utf-8").trim();
    const parsed = JSON.parse(line) as LlmCallLogEntry;
    expect(parsed.usage).toEqual({ input: 100, output: 20, cacheRead: 300, cacheWrite: 40, totalTokens: 460, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

    const [fromHistory] = await llm.getHistory();
    expect(fromHistory?.usage?.cacheWrite).toBe(40);
    rmSync(dir, { recursive: true, force: true });
  });

  test("tokenTotals 累计 cacheWrite", async () => {
    const llm = runtime(false);
    await llm.complete("fake/m", [{ role: "user", content: "x" }], { retry: { maxRetries: 0 } });
    hooks.usage = usageOf(1, 2, 3, 4);
    await llm.complete("fake/m", [{ role: "user", content: "y" }], { retry: { maxRetries: 0 } });
    expect(llm.getTokenTotals()).toEqual({ input: 101, output: 22, cacheRead: 303, cacheWrite: 44 });
  });

  test("provider 不回 usage → 条目无 usage 且累计不动", async () => {
    hooks.usage = undefined;
    const llm = runtime(false);
    await llm.complete("fake/m", [{ role: "user", content: "x" }], { retry: { maxRetries: 0 } });
    expect(llm.getCallLog()[0]?.usage).toBeUndefined();
    expect(llm.getTokenTotals()).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  test("旧格式历史行（无 usage）照常读出，usage 为 undefined", async () => {
    const dir = tempDir();
    const historyPath = join(dir, "llm-history.jsonl");
    // R0-2 之前写下的行：没有 usage 键
    const legacy = JSON.stringify({ id: "old-1", model: "fake/m", ok: true, prompt: "p", response: "r", ms: 1, ts: 1 });
    writeFileSync(historyPath, legacy + "\n", "utf-8");
    const llm = runtime(historyPath);
    const entries = await llm.getHistory();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("old-1");
    expect(entries[0]?.usage).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  test("历史行的 usage 形态损坏 → 丢弃该字段而不是把脏值端给消费方", async () => {
    const dir = tempDir();
    const historyPath = join(dir, "llm-history.jsonl");
    const broken = JSON.stringify({ id: "bad-1", model: "fake/m", ok: true, prompt: "p", response: "r", ms: 1, ts: 1, usage: "300" });
    writeFileSync(historyPath, broken + "\n", "utf-8");
    const llm = runtime(historyPath);
    const entries = await llm.getHistory();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.usage).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});
