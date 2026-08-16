/**
 * 用量去向的展示逻辑（TR-10）。纯函数，DOM 读写留在 workspace-bridge——
 * 与 `model-indicator.ts` / `thinking-view.ts` 同一分法（渲染层 vitest 是 node 环境）。
 *
 * ## 它要回答的问题
 *
 * **这些 token 花在哪了。**
 *
 * 控制台页脚此前只有 input / output / cacheRead / cacheWrite 四个聚合数字。
 * 用户看到「输出 81166」，既不知道是哪一章吃掉的，也不知道其中多少是思考。
 *
 * 界面上**不算「废掉多少」这笔账**：重试是系统正常运转的一部分，把它标成
 * 白花的钱，是把内部的记账焦虑摆到用户面前。废耗数据留在诊断报告与账本里，
 * 那是排障工具，不是产品界面。
 *
 * 口径与命令行跑批共用 `buildUsageReport` / `groupUsageByLabel`：
 * 界面和跑批印出来的必须是同一套结论，否则两边对不上时人不知道该信哪个。
 */

export interface UsageGroupInput {
  label: string;
  attempts: number;
  wastedAttempts: number;
  ms: number;
  input: number;
  cacheRead: number;
  output: number;
  wastedOutput: number;
  reasoningChars: number;
  textChars: number;
  reasoningRatio: number;
  ceilingHits: number;
  wastedByKind: Record<string, number>;
  effectiveThinking: Record<string, number>;
}

export interface UsageReportInput {
  attempts: number;
  wastedAttempts: number;
  wastedRatio: number;
  wastedMs: number;
  wastedOutput: number;
  wastedByKind: Record<string, number>;
  ms: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheHitRatio: number;
  downgraded: number;
  effectiveThinking: Record<string, number>;
  reasoningRatio: number;
  incomplete: number;
  ceilingHits: number;
  findings: string[];
}

export interface UsageRow {
  label: string;
  /** 「5 次尝试」 */
  attemptsText: string;
  outputText: string;
  /** 思考占产出的比例。放进行里而不是只放总计：贵在哪一章，一眼就该看见 */
  reasoningText: string;
  /** 触顶等需要不同动作的提示 */
  noteText: string;
  /** 有过没交付结果的尝试。只用来标记，不在界面上算账 */
  tone: "ok" | "bad";
}

export interface UsageView {
  empty: boolean;
  rows: UsageRow[];
  total: string;
  findings: string[];
}

/** 上千折成 k。81166 直接糊在句子里没人能一眼判断量级 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value));
}

const pct = (value: number): string => `${Math.round((Number.isFinite(value) ? value : 0) * 100)}%`;

export function describeUsage(input: { report: UsageReportInput; groups: UsageGroupInput[] }): UsageView {
  const { report, groups } = input;
  const rows: UsageRow[] = groups.map((g) => {
    const kinds = Object.entries(g.wastedByKind).sort((a, b) => b[1] - a[1]);
    const notes: string[] = [];
    // 触顶单独说：它指向的动作是改配置（抬高 maxTokens 或降档），
    // 与「瞬态错误重试一下就好」不是一回事。
    if (g.ceilingHits > 0) notes.push(`触顶 ${g.ceilingHits} 次`);
    if (kinds.length > 0) notes.push(kinds.map(([kind, count]) => `${kind} ×${count}`).join(" · "));
    return {
      label: g.label,
      attemptsText: `${g.attempts} 次尝试`,
      outputText: `输出 ${formatTokens(g.output)}`,
      reasoningText: `思考占 ${pct(g.reasoningRatio)}`,
      noteText: notes.join(" · "),
      tone: g.wastedAttempts > 0 ? "bad" : "ok",
    };
  });

  const total = [
    `输入 ${formatTokens(report.input)}`,
    `命中缓存 ${formatTokens(report.cacheRead)}（${pct(report.cacheHitRatio)}）`,
    `输出 ${formatTokens(report.output)}`,
    `思考占 ${pct(report.reasoningRatio)}`,
  ].join(" · ");

  return {
    // 没跑过就说没跑过，不给一张全是 0 的表——那会让人以为「花了 0」而不是「还没花」
    empty: report.attempts === 0,
    rows,
    total,
    // 结论原样带出：报告已经给了可执行的话，展示层再复述一遍只会稀释它
    findings: report.findings,
  };
}
