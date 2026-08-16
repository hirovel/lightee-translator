/**
 * 用量去向的展示逻辑（纯函数）。渲染层 vitest 跑在 node 环境无 DOM，
 * 能钉死的只有这一层；DOM 读写留在 workspace-bridge。
 *
 * 它要回答的问题只有一个：**这些 token 花在哪了。**
 *
 * 控制台页脚此前只有 input / output / cacheRead / cacheWrite 四个聚合数字。
 * 用户看到「输出 81166」，既不知道是哪一章吃掉的，也不知道其中多少是思考、
 * 多少废在没交付结果的尝试上——而这两块恰恰是最贵的。
 */
import { describe, expect, it } from "vitest";
import { describeUsage, formatTokens } from "./usage-view.js";

const group = (over: Partial<Parameters<typeof describeUsage>[0]["groups"][number]>) => ({
  label: "translate:ch001", attempts: 1, wastedAttempts: 0, ms: 1000,
  input: 100, cacheRead: 0, output: 1000, wastedOutput: 0,
  reasoningChars: 100, textChars: 900, reasoningRatio: 0.1, ceilingHits: 0,
  wastedByKind: {}, effectiveThinking: {}, ...over,
});

const report = (over: Partial<Parameters<typeof describeUsage>[0]["report"]> = {}) => ({
  attempts: 1, wastedAttempts: 0, wastedRatio: 0, wastedMs: 0, wastedOutput: 0, wastedByKind: {},
  ms: 1000, input: 100, output: 1000, cacheRead: 0, cacheWrite: 0, cacheHitRatio: 0,
  downgraded: 0, effectiveThinking: {}, reasoningRatio: 0.1, incomplete: 0, ceilingHits: 0,
  findings: [], ...over,
});

describe("formatTokens", () => {
  it("上千折成 k，读得出量级——81166 直接糊在句子里没人能一眼判断大小", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(81166)).toBe("81.2k");
    expect(formatTokens(0)).toBe("0");
  });
});

describe("describeUsage", () => {
  it("每一章一行，花得多的在前，且输出拆成思考与正文两截", () => {
    const view = describeUsage({
      report: report({ output: 24170 }),
      groups: [
        group({ label: "translate:ch002", output: 24170, reasoningChars: 44064, textChars: 13517, reasoningRatio: 44064 / 57581 }),
        group({ label: "translate:ch001", output: 2000 }),
      ],
    });
    expect(view.rows.map((r) => r.label)).toEqual(["translate:ch002", "translate:ch001"]);
    expect(view.rows[0]!.outputText).toContain("24.2k");
    // 思考占比要在行里直接看得到，不能只在总计里
    expect(view.rows[0]!.reasoningText).toContain("77%");
  });

  /**
   * 界面上不算「废掉多少」这笔账：重试是系统正常运转的一部分，把它标成白花的钱，
   * 是把内部的记账焦虑摆到用户面前。废耗数据留在诊断报告与账本里。
   */
  it("任何一行都不出现废耗金额", () => {
    const view = describeUsage({
      report: report({ wastedAttempts: 4, wastedOutput: 65535, wastedRatio: 0.57 }),
      groups: [group({ label: "translate:ch002", attempts: 5, wastedAttempts: 4, output: 73321, wastedOutput: 65535, wastedByKind: { incomplete: 4 } })],
    });
    expect(JSON.stringify(view)).not.toContain("废掉");
    expect(JSON.stringify(view)).not.toContain("65.5k");
  });

  it("总计行也不出现废耗金额", () => {
    const view = describeUsage({ report: report({ wastedOutput: 65535, output: 81166 }), groups: [group({})] });
    expect(view.total).not.toContain("废");
  });

  it("触顶单独提示——它指向的动作是改配置，与其他废因不同", () => {
    const view = describeUsage({ report: report({ ceilingHits: 4 }), groups: [group({ ceilingHits: 4, wastedAttempts: 4 })] });
    expect(view.rows[0]!.noteText).toContain("触顶");
  });

  it("总计行把输入侧的缓存命中单列——命中与未命中单价差一个数量级", () => {
    const view = describeUsage({
      report: report({ input: 3834, cacheRead: 14080, cacheHitRatio: 14080 / (3834 + 14080), output: 81166 }),
      groups: [group({})],
    });
    expect(view.total).toContain("3.8k");
    expect(view.total).toContain("14.1k");
    expect(view.total).toContain("79%");
  });

  it("结论原样带出——报告已经给了可执行的话，展示层不该再复述一遍", () => {
    const view = describeUsage({ report: report({ findings: ["推理占产出的 88%"] }), groups: [group({})] });
    expect(view.findings).toEqual(["推理占产出的 88%"]);
  });

  it("空账本给一句人话，而不是一张全是 0 的表", () => {
    const view = describeUsage({ report: report({ attempts: 0, output: 0, input: 0 }), groups: [] });
    expect(view.rows).toEqual([]);
    expect(view.empty).toBe(true);
  });
});
