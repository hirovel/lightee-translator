import { describe, expect, it } from "vitest";
import { buildUsageReport, groupUsageByLabel, renderUsageReport } from "./usage-report.js";
import type { UsageRecord } from "./usage-ledger.js";

function row(over: Partial<UsageRecord>): UsageRecord {
  return {
    ts: 1, label: "translate:ch001", model: "p/m", attempts: 1, ok: true,
    ms: 1000, input: 100, output: 100, cacheRead: 0, cacheWrite: 0, ...over,
  };
}

describe("buildUsageReport", () => {
  it("把废掉的尝试和真正交付的尝试分开算——这是账本存在的理由", () => {
    const report = buildUsageReport([
      row({ ok: false, attempt: 1, thinking: "max", thinkingRequested: "max", errorKind: "empty_response", ms: 60_000, output: 8190, reasoningChars: 13447, textChars: 0 }),
      row({ ok: false, attempt: 2, thinking: "xhigh", thinkingRequested: "max", errorKind: "empty_response", ms: 60_000, output: 8190, reasoningChars: 13000, textChars: 0 }),
      row({ ok: true, attempt: 3, thinking: "low", thinkingRequested: "max", attempts: 3, ms: 60_000, output: 1861, reasoningChars: 388, textChars: 3336 }),
    ]);
    expect(report.attempts).toBe(3);
    expect(report.wastedAttempts).toBe(2);
    expect(report.wastedRatio).toBeCloseTo(2 / 3);
    expect(report.wastedMs).toBe(120_000);
    // 废掉的 output 是最贵的一块，必须单列
    expect(report.wastedOutput).toBe(16380);
    expect(report.output).toBe(18241);
  });

  it("按 errorKind 统计废因——「重试了 20 次」不说明任何事，「20 次都是空响应」才说明", () => {
    const report = buildUsageReport([
      row({ ok: false, errorKind: "empty_response" }),
      row({ ok: false, errorKind: "empty_response" }),
      row({ ok: false, errorKind: "transient" }),
      row({ ok: true }),
    ]);
    expect(report.wastedByKind).toEqual({ empty_response: 2, transient: 1 });
  });

  it("识别降档：请求档位与生效档位不同即记一次，并报出落到了哪一档", () => {
    const report = buildUsageReport([
      row({ ok: true, thinking: "low", thinkingRequested: "max", attempts: 5 }),
      row({ ok: true, thinking: "low", thinkingRequested: "max", attempts: 1 }),
      row({ ok: true, thinking: "high", thinkingRequested: "high" }),
    ]);
    expect(report.downgraded).toBe(2);
    expect(report.effectiveThinking).toEqual({ low: 2, high: 1 });
  });

  it("没有上报推理 token 时按字符估——估算是退路，不是默认", () => {
    const report = buildUsageReport([row({ reasoningChars: 13447, textChars: 174 })]);
    expect(report.reasoningRatio).toBeCloseTo(13447 / (13447 + 174));
    expect(report.reasoningBasis).toBe("chars");
  });

  /**
   * TR-12：服务商上报了 `output_tokens_details.reasoning_tokens` 时必须用上报值。
   * 此前整条链把它丢在引擎侧，报告只能按字符估（还为此标定过 2.26 字符/token）——
   * 真值就在账本旁边，报告却在用估的。
   */
  it("有上报推理 token 时按 token 算（reasoning/output），并说明口径", () => {
    const report = buildUsageReport([row({ output: 10000, reasoning: 9000, reasoningChars: 20340, textChars: 174 })]);
    expect(report.reasoningRatio).toBeCloseTo(0.9);
    expect(report.reasoningBasis).toBe("tokens");
    expect(renderUsageReport(report)).toContain("按上报 token");
  });

  it("stopReason=length 只记「未正常结束」——它证明不了被截断", () => {
    const report = buildUsageReport([row({ stopReason: "stop" }), row({ stopReason: "length" })]);
    expect(report.incomplete).toBe(1);
  });

  /**
   * TR-12：`stopReason=length` 是所有 incomplete 的有损压缩，`rawStopReason` 才是
   * 服务商原话。completions 路径正常结束的行 rawStopReason="stop"、stopReason 也可能
   * 是 "length"（真触到 max_tokens）——有原始状态时必须按原始状态判。
   */
  it("有 rawStopReason 时按它判未正常结束，不再看有损的 stopReason", () => {
    const report = buildUsageReport([
      row({ stopReason: "length", rawStopReason: "incomplete" }),  // 真·没正常结束
      row({ stopReason: "stop", rawStopReason: "completed" }),      // 正常
      row({ stopReason: "length" }),                                 // 老账本行：退回 length
    ]);
    expect(report.incomplete).toBe(2);
  });

  /**
   * 2026-08-12 第二次跑批的决定性读数：四次失败的 output 是 16382/16382/16383/16385，
   * 配置里的 maxTokens 正是 16384。碰上限的全失败、低于上限的全成功。
   *
   * 报告当时写的是「被服务商截断」——**归因错了**。天花板是我们自己设的。
   * 归因错，下一步动作就跟着错：会去找服务商，而不是去改自己的配置。
   */
  it("output 落在自己设的 maxTokens 上 → 记为触顶，不算在服务商头上", () => {
    const report = buildUsageReport([
      row({ ok: false, output: 16382, maxTokens: 16384, stopReason: "length", errorKind: "incomplete" }),
      row({ ok: false, output: 16385, maxTokens: 16384, stopReason: "length", errorKind: "incomplete" }),
      row({ ok: true, output: 3379, maxTokens: 16384, stopReason: "stop" }),
    ]);
    expect(report.ceilingHits).toBe(2);
    expect(report.findings.join("\n")).toContain("16384");
    expect(report.findings.join("\n")).toContain("自己");
    // 有触顶证据时，就不该再有一句把同一件事栽给服务商
    expect(report.findings.join("\n")).not.toContain("被服务商截断");
  });

  it("没配 maxTokens 时不判触顶——没有天花板就无从谈碰到", () => {
    const report = buildUsageReport([row({ ok: false, output: 16382, stopReason: "length", errorKind: "incomplete" })]);
    expect(report.ceilingHits).toBe(0);
    expect(report.findings.join("\n")).toContain("原因未知");
  });

  it("缓存命中率按输入侧算，命中为零时如实报零而不是留空", () => {
    const report = buildUsageReport([row({ input: 900, cacheRead: 100 })]);
    expect(report.cacheHitRatio).toBeCloseTo(0.1);
  });

  /**
   * 聚合总量回答不了「钱花在哪」。UI 页脚此前只有 input/output/cacheRead/cacheWrite
   * 四个数字，用户看到「输出 81166」既不知道哪一章吃掉的，也不知道其中多少是思考、
   * 多少是废掉的尝试——而这两件正是本轮诊断里最贵的部分。
   */
  it("按标签分组：每一章各自的花销、思考占比、废掉多少，都要能单独看", () => {
    const groups = groupUsageByLabel([
      row({ label: "translate:ch001", ok: true, output: 2000, input: 100, cacheRead: 900, reasoningChars: 500, textChars: 3000, ms: 10_000 }),
      row({ label: "translate:ch002", ok: false, output: 16384, errorKind: "incomplete", reasoningChars: 43302, textChars: 0, ms: 130_000 }),
      row({ label: "translate:ch002", ok: true, output: 7786, reasoningChars: 762, textChars: 13517, ms: 70_000 }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["translate:ch002", "translate:ch001"]); // 花得多的排前面
    const ch002 = groups[0]!;
    expect(ch002.attempts).toBe(2);
    expect(ch002.output).toBe(24170);
    expect(ch002.wastedOutput).toBe(16384);
    expect(ch002.reasoningRatio).toBeCloseTo(44064 / (44064 + 13517));
  });

  it("分组里也带上触顶与废因——不然还是要人自己去翻明细", () => {
    const groups = groupUsageByLabel([
      row({ label: "translate:ch002", ok: false, output: 16384, maxTokens: 16384, errorKind: "incomplete", stopReason: "length" }),
      row({ label: "translate:ch002", ok: true, output: 500 }),
    ]);
    expect(groups[0]!.ceilingHits).toBe(1);
    expect(groups[0]!.wastedByKind).toEqual({ incomplete: 1 });
  });

  it("空账本分组为空数组，不产出占位行", () => {
    expect(groupUsageByLabel([])).toEqual([]);
  });

  it("空账本不产出假报告", () => {
    const report = buildUsageReport([]);
    expect(report.attempts).toBe(0);
    expect(report.findings).toEqual([]);
  });
});

describe("findings：报告要给结论，不是给一堆数字让人自己看", () => {
  it("废尝试过半 → 点名最大废因与预计可省时间", () => {
    const rows = [
      ...Array.from({ length: 4 }, () => row({ ok: false, errorKind: "empty_response", ms: 60_000, output: 8190 })),
      row({ ok: true, attempts: 5, ms: 60_000 }),
    ];
    const findings = buildUsageReport(rows).findings.join("\n");
    expect(findings).toContain("empty_response");
    expect(findings).toMatch(/80%|4\/5/);
  });

  it("思考占比高不再算「发现」——作者选了高档位就是选了，不该每跑一次都被劝一次降档", () => {
    // 作者裁定 2026-08-13：思考吃掉大半产出是深度思考档位的正常形态，不是故障。
    // 占比仍在页脚数字里可查；真正的异常（白跑、降档、触顶）各有专条，不受这条撤销影响。
    const findings = buildUsageReport([row({ reasoningChars: 13447, textChars: 174, thinking: "max" })]).findings.join("\n");
    expect(findings).not.toContain("推理");
  });

  it("一切正常时不硬凑结论——没有发现就是没有发现", () => {
    expect(buildUsageReport([row({ reasoningChars: 100, textChars: 5000, cacheRead: 500, input: 500 })]).findings).toEqual([]);
  });
});

describe("renderUsageReport", () => {
  it("渲染成人能读的文本，且不含任何正文（只有数字与档位名）", () => {
    const text = renderUsageReport(buildUsageReport([
      row({ ok: false, errorKind: "empty_response", reasoningChars: 13447, textChars: 0 }),
      row({ ok: true, attempts: 2, thinking: "low", thinkingRequested: "max" }),
    ]));
    expect(text).toContain("尝试");
    expect(text).toContain("empty_response");
    expect(text).not.toContain("undefined");
  });
});
