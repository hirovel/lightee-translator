/**
 * TR-08：输出预算按**推理是输出的倍数**来估，而不是加一个常数。
 *
 * ## 事实
 *
 * 2026-08-12 跑批读出来的（llm-history.jsonl，逐尝试落盘之后才拿得到）：
 *
 * | 尝试            | 本批要求 | 思考里译到 | 正式输出 |
 * |-----------------|---------|-----------|---------|
 * | ch002 · max     | 95 段   | **95 段** | **0**   |
 * | ch002 · high    | 95 段   | **95 段** | **0**   |
 * | ch002 · low     | 95 段   | **0 段**  | 95 段   |
 *
 * 模型在 medium 及以上会**先在思考块里把整章译一遍**，然后才开始正式输出；
 * low 档一段草稿都不打，直接吐。这是个二元开关，不是连续的量。
 *
 * ch002 实测：正文要 7786 token，而思考吃掉 16384 还没结束——总需求 ≥ 24000。
 *
 * ## 为什么原来的公式必然放行注定失败的请求
 *
 * `srcChars / 1.5 + 2000`：把推理当成一个**固定 2000 token 的加项**。
 * 实测 max 档是 16384+，偏小 8 倍以上。于是发车前的闸门判定「装得下」，
 * 把注定撞墙的整章请求发了出去。
 *
 * ## 判据来源
 *
 * OpenAI 的推理模型指南写明推理 token 计入 `max_output_tokens`，并建议
 * 「reserve at least 25,000 tokens for reasoning and outputs」；预算在推理阶段
 * 耗尽时返回 incomplete 且**没有可见输出**——与我们观测到的现象逐字吻合。
 */
import { describe, expect, test } from "vitest";
import { estimateOutputTokens, needsBatchTranslation } from "../src/translate-one.ts";

/** ch002 的真实量级：源文约 14000 字符 */
const CH002_SRC = 14000;

describe("推理开销按倍数算", () => {
  test("高档位下预估至少是可见输出的数倍——实测 ch002 思考吃满 16384 仍未写完正文", () => {
    const visible = Math.ceil(CH002_SRC / 1.5);
    expect(estimateOutputTokens(CH002_SRC, "max")).toBeGreaterThanOrEqual(visible * 3);
  });

  test("低档位不打草稿，预估贴近可见输出——实测 low 档思考 762 字符 / 正文 13517 字符", () => {
    const visible = Math.ceil(CH002_SRC / 1.5);
    const low = estimateOutputTokens(CH002_SRC, "low");
    expect(low).toBeGreaterThanOrEqual(visible);
    expect(low).toBeLessThan(visible * 2);
  });

  test("档位越高预估越大，且 off 最小——预算判定必须知道这次要不要打草稿", () => {
    const off = estimateOutputTokens(CH002_SRC, "off");
    const low = estimateOutputTokens(CH002_SRC, "low");
    const max = estimateOutputTokens(CH002_SRC, "max");
    expect(off).toBeLessThanOrEqual(low);
    expect(low).toBeLessThan(max);
  });

  test("不传档位时按最坏情况估——宁可多分一批，也别发出去等着一个字都拿不到", () => {
    expect(estimateOutputTokens(CH002_SRC)).toBe(estimateOutputTokens(CH002_SRC, "max"));
  });
});

describe("发车前的闸门", () => {
  /**
   * 这条是这次事故的正面回归：旧公式在 16384 下判定 ch002「装得下」，
   * 于是整章单发，四次尝试、四次一个字都没拿到。
   */
  test("16384 预算 + max 档 → 必须判定装不下，转分批", () => {
    expect(needsBatchTranslation(CH002_SRC, 16384, "max")).toBe(true);
  });

  test("16384 预算 + low 档 → 装得下，不必平白分批（实测 low 档单发一次就成）", () => {
    expect(needsBatchTranslation(CH002_SRC, 16384, "low")).toBe(false);
  });

  test("65536 预算 + max 档 → 装得下，整章单发", () => {
    expect(needsBatchTranslation(CH002_SRC, 65536, "max")).toBe(false);
  });

  test("同一章在预算变小时更早转分批（单调性）", () => {
    expect(needsBatchTranslation(CH002_SRC, 8192, "max")).toBe(true);
    expect(needsBatchTranslation(CH002_SRC, 200000, "max")).toBe(false);
  });
});
