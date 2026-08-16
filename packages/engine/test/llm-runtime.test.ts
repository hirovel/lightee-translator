import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmRuntime, type LlmCallLogEntry } from "../src/llm-runtime.ts";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "lightee-llm-runtime-"));
}

// 无效 baseUrl provider：complete 会走到网络失败 → 走 pushCallLog 失败分支 → 历史持久化
function failingRuntime(dir: string, historyFile?: string | false) {
  return LlmRuntime.create({
    configDir: dir,
    historyFile,
    providers: {
      fake: {
        name: "fake",
        baseUrl: "http://127.0.0.1:1/v1", // 无服务端口 → 连接失败
        models: [{ id: "m", name: "m" }],
      },
    },
  });
}

describe("LlmRuntime 历史持久化", () => {
  test("失败调用写入历史（messages 完整 + getHistory 可读）", async () => {
    const dir = tempDir();
    const historyPath = join(dir, "llm-history.jsonl");
    const llm = failingRuntime(dir, historyPath);
    await llm
      .complete("fake/m", [{ role: "user", content: "こんにちは" }], { thinking: "low", retry: { maxRetries: 0 } })
      .catch(() => {});

    expect(existsSync(historyPath)).toBe(true);
    const entries = await llm.getHistory();
    expect(entries.length).toBe(1);
    const e = entries[0]!;
    expect(e.ok).toBe(false);
    expect(e.error).toBeTruthy();
    expect(e.messages).toEqual([{ role: "user", content: "こんにちは" }]);
    expect(e.prompt).toContain("こんにちは");
    expect(typeof e.ms).toBe("number");
    expect(typeof e.ts).toBe("number");
    expect(e.id).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  });

  test("historyFile: false → 不写文件、getHistory 空", async () => {
    const dir = tempDir();
    const llm = failingRuntime(dir, false);
    await llm.complete("fake/m", [{ role: "user", content: "x" }], { retry: { maxRetries: 0 } }).catch(() => {});
    expect(existsSync(join(dir, "llm-history.jsonl"))).toBe(false);
    expect(await llm.getHistory()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("历史文件 JSONL 每行一条完整记录（含新字段）", async () => {
    const dir = tempDir();
    const historyPath = join(dir, "llm-history.jsonl");
    const llm = failingRuntime(dir, historyPath);
    await llm
      .complete("fake/m", [{ role: "system", content: "sys" }, { role: "user", content: "usr" }], { retry: { maxRetries: 0 } })
      .catch(() => {});
    const raw = readFileSync(historyPath, "utf-8").trim().split("\n");
    expect(raw.length).toBe(1);
    const parsed = JSON.parse(raw[0]!) as LlmCallLogEntry;
    expect(parsed.messages?.length).toBe(2);
    expect(parsed.messages?.[0]?.role).toBe("system");
    // 失败 entry：ttftMs/reasoning 为 undefined（undefined 键被 JSON 省略）；验必有字段
    expect(parsed.ttftMs === undefined).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.error).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  });

  test("getHistory 从既有文件读取（新→旧 + limit + 损坏行跳过）", async () => {
    const dir = tempDir();
    const historyPath = join(dir, "llm-history.jsonl");
    const mk = (id: string) => JSON.stringify({ id, label: "t", model: "fake/m", ok: true, prompt: "p", messages: [], response: "r", ms: 1, ts: 1 }) + "\n";
    // 手动构造：损坏行 + 3 条合法（id a1 < a2 < a3 时间顺序）
    // eslint-disable-next-line no-irregular-whitespace
    const { writeFileSync } = await import("node:fs");
    writeFileSync(historyPath, "{\"broken\"\n" + mk("a1") + mk("a2") + mk("a3"), "utf-8");
    const llm = LlmRuntime.create({ configDir: dir, historyFile: historyPath, providers: {} });
    const all = await llm.getHistory();
    expect(all.length).toBe(3); // 损坏行跳过
    expect(all.map((e) => e.id)).toEqual(["a3", "a2", "a1"]); // 新→旧
    const limited = await llm.getHistory(2);
    expect(limited.map((e) => e.id)).toEqual(["a3", "a2"]);
    rmSync(dir, { recursive: true, force: true });
  });
});
