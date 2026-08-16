/**
 * compaction 测试：pi 三件套（触发/切点/结构化摘要）。
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_COMPACTION,
  shouldCompact,
  findCutPoint,
  generateSummary,
  buildSummaryMessages,
} from "../src/compaction.ts";

describe("compaction（pi 参考）", () => {
  it("shouldCompact：超阈值触发（窗口-保留）", () => {
    expect(shouldCompact(10000, 32768, DEFAULT_COMPACTION)).toBe(false); // 10000 < 16384
    expect(shouldCompact(20000, 32768, DEFAULT_COMPACTION)).toBe(true); // 20000 > 16384
  });

  it("shouldCompact：disabled 不触发", () => {
    expect(shouldCompact(99999, 32768, { ...DEFAULT_COMPACTION, enabled: false })).toBe(false);
  });

  it("findCutPoint：保留最近 keepRecentTokens，前面全压缩", () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({ tokens: 500 })); // 50000 token
    const cut = findCutPoint(entries, 0, entries.length, 20000);
    // 保留最近 20000/500 = 40 条，切点 = 60
    expect(cut).toBe(60);
  });

  it("buildSummaryMessages：结构化 checkpoint 提示", () => {
    const messages = buildSummaryMessages(
      [{ role: "system", content: "sys" }, { role: "user", content: "任务: 翻译《屋上の灯》" }],
      "前次摘要: 已完成 3 章"
    );
    const joined = messages.map((m) => m.content).join("\n");
    expect(joined).toContain("structured context checkpoint");
    expect(joined).toContain("前次摘要: 已完成 3 章");
  });

  it("generateSummary：LLM 摘要 + 失败返回空（不阻断）", async () => {
    const ok = await generateSummary(
      async () => "压缩摘要: 已完成 3/10 章，ch004 翻译中",
      [],
      "前次摘要"
    );
    expect(ok).toContain("3/10");

    const fail = await generateSummary(
      async () => { throw new Error("down"); },
      [],
      "前次摘要"
    );
    expect(fail).toBe("");
  });
});
