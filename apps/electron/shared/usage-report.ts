/**
 * 用量报告（Agent 调用信息报告系统）。
 *
 * ## 为什么要有这一层
 *
 * 账本回答「记了什么」，报告回答「出了什么事」。2026-08-12 那次真实跑批里，
 * 从「26 分钟翻 3 章」到「模型把 99% 的输出预算花在推理上」之间，隔着五六个
 * 手写的一次性 node 脚本。那些脚本每次都要重写，而且要去刨含正文的
 * `llm-history.jsonl`——一份不该被随手打开、也不该被分享的文件。
 *
 * 结论应该由系统给出，不该每次靠人现推。所以这里做两件事：
 * 1. `buildUsageReport` 把账本行聚合成结构化事实（纯函数，可测）；
 * 2. `findings` 在事实达到判据时**给出结论**——报告不是数字堆，是诊断。
 *
 * ## 判据的取舍
 *
 * 只在证据足够时下结论，宁可不报也不制造噪音（一个总在响的警报等于没有警报）。
 * 所有输入都来自账本的白名单字段，因此报告在结构上不可能带出正文或密钥。
 */
import type { UsageRecord } from "./usage-ledger.js";

export interface UsageReport {
  /** 网络尝试总数（账本一行 = 一次尝试） */
  attempts: number;
  /** 其中没能交付结果的 */
  wastedAttempts: number;
  wastedRatio: number;
  /** 废掉的尝试消耗的墙钟与输出 token——最贵的一块，必须能单独看到 */
  wastedMs: number;
  wastedOutput: number;
  /** 废因分布：`{ empty_response: 20, transient: 3 }` */
  wastedByKind: Record<string, number>;
  ms: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 命中缓存占输入侧的比例（input + cacheRead 为分母） */
  cacheHitRatio: number;
  /** 请求档位 ≠ 生效档位的次数 */
  downgraded: number;
  /** 实际生效的档位分布 */
  effectiveThinking: Record<string, number>;
  /** 推理占产出的比例。口径见 {@link reasoningBasis} */
  reasoningRatio: number;
  /**
   * 推理占比的口径（TR-12）。有服务商上报的推理 token 数（`reasoning` 字段）时
   * 按 token 算（reasoning / output）；没有才退回字符估算。
   * 报告必须说明自己用的是哪个口径——两个口径的数字不可直接比较。
   */
  reasoningBasis: "tokens" | "chars";
  /**
   * `stopReason === "length"` 的次数。名字叫 incomplete 不叫 truncated 是有意的：
   * pi-ai 把所有 `status:"incomplete"` 都映射成 `"length"`，这个字段只能说明
   * 「没正常结束」，**证明不了被截断**。真要判截断看 {@link ceilingHits}。
   */
  incomplete: number;
  /**
   * output 落在本行自己的 `maxTokens` 上的次数——**撞的是我们自己设的天花板**。
   *
   * 这一栏是 2026-08-12 那次误判的解药：当时报告写「被服务商截断」，
   * 而真相是配置里的 16384 被思考吃光了。归因错，下一步动作就跟着错。
   */
  ceilingHits: number;
  /** 达到判据的结论。没有发现就是空数组 */
  findings: string[];
}

/** 废尝试占比超过这条线就值得点名——过半意味着大部分钱花在没有产出的调用上 */
const WASTED_RATIO_ALERT = 0.5;
/** 样本太少时不下结论：一两次波动推不出趋势 */
const MIN_SAMPLES_FOR_FINDING = 3;
/**
 * 判「触顶」的容差。实测 output 会**略微越过**发出去的上限
 * （16384 的预算下拿到过 16385），服务商与我们的计数口径本就不完全一致。
 * 用 98% 而不是严格相等——严格相等会把 16382 判成「没到上限」，
 * 而那正是需要被点名的那一次。
 */
const CEILING_TOLERANCE = 0.98;

/** 触顶那几行各自的预算值——报告要说出**是哪个数字**顶住了，人才知道去改哪里 */
const ceilings = (rows: ReadonlyArray<UsageRecord>): number[] =>
  rows.filter((row) => row.maxTokens !== undefined && row.output >= row.maxTokens * CEILING_TOLERANCE)
    .map((row) => row.maxTokens!);

const ratio = (part: number, whole: number): number => (whole > 0 ? part / whole : 0);
const pct = (value: number): string => `${Math.round(value * 100)}%`;
/** 推理占比口径的人话（token 是服务商上报的真值，字符是估算的退路） */
const basisLabel = (basis: "tokens" | "chars"): string => (basis === "tokens" ? "按上报 token" : "按字符");

export function buildUsageReport(rows: ReadonlyArray<UsageRecord>): UsageReport {
  const wasted = rows.filter((row) => !row.ok);
  const wastedByKind: Record<string, number> = {};
  for (const row of wasted) {
    const kind = row.errorKind ?? "unknown";
    wastedByKind[kind] = (wastedByKind[kind] ?? 0) + 1;
  }
  const effectiveThinking: Record<string, number> = {};
  for (const row of rows) {
    if (!row.thinking) continue;
    effectiveThinking[row.thinking] = (effectiveThinking[row.thinking] ?? 0) + 1;
  }
  const sum = (pick: (row: UsageRecord) => number): number => rows.reduce((total, row) => total + pick(row), 0);
  const reasoningChars = sum((row) => row.reasoningChars ?? 0);
  const textChars = sum((row) => row.textChars ?? 0);
  // 服务商上报的推理 token 数（TR-12）。有上报值就用上报值——字符估算是退路
  const reasoningTokens = sum((row) => row.reasoning ?? 0);
  const output = sum((row) => row.output);
  const input = sum((row) => row.input);
  const cacheRead = sum((row) => row.cacheRead);

  const report: UsageReport = {
    attempts: rows.length,
    wastedAttempts: wasted.length,
    wastedRatio: ratio(wasted.length, rows.length),
    wastedMs: wasted.reduce((total, row) => total + row.ms, 0),
    wastedOutput: wasted.reduce((total, row) => total + row.output, 0),
    wastedByKind,
    ms: sum((row) => row.ms),
    input,
    output,
    cacheRead,
    cacheWrite: sum((row) => row.cacheWrite),
    cacheHitRatio: ratio(cacheRead, input + cacheRead),
    downgraded: rows.filter((row) => row.thinkingRequested && row.thinking && row.thinkingRequested !== row.thinking).length,
    effectiveThinking,
    reasoningRatio: reasoningTokens > 0 ? ratio(reasoningTokens, output) : ratio(reasoningChars, reasoningChars + textChars),
    reasoningBasis: reasoningTokens > 0 ? "tokens" : "chars",
    // 有原始状态就按原始状态判（只有 incomplete 才真正证明没正常结束）；
    // 老账本行没有这一栏，退回归一后的 length——那是有损的，但也是仅有的
    incomplete: rows.filter((row) => (row.rawStopReason ? row.rawStopReason === "incomplete" : row.stopReason === "length")).length,
    ceilingHits: rows.filter((row) => row.maxTokens !== undefined && row.output >= row.maxTokens * CEILING_TOLERANCE).length,
    findings: [],
  };
  report.findings = deriveFindings(report, rows.length, ceilings(rows));
  return report;
}

/**
 * 从事实推结论。每一条都要能直接指向下一步动作——
 * 「慢」不是结论，「4/5 的尝试是空响应、换档位可省 X 分钟」才是。
 */
function deriveFindings(report: UsageReport, sampleCount: number, ceilingValues: number[]): string[] {
  const findings: string[] = [];

  // 样本门槛只管**比率型**结论：几次尝试的成败推不出趋势。
  // 推理占比、截断、降档不受它约束——单次 13447:174 就是决定性证据，
  // 硬要凑够三次才肯说，等于把已经看见的事实压着不报。
  if (sampleCount >= MIN_SAMPLES_FOR_FINDING && report.wastedRatio >= WASTED_RATIO_ALERT) {
    const [topKind, topCount] = Object.entries(report.wastedByKind).sort((a, b) => b[1] - a[1])[0] ?? ["unknown", 0];
    findings.push(
      `${report.wastedAttempts}/${report.attempts}（${pct(report.wastedRatio)}）的网络尝试没有交付结果，`
      + `主因 ${topKind} ×${topCount}；这些尝试烧掉 ${report.wastedOutput} 输出 token、`
      + `${Math.round(report.wastedMs / 1000)}s 墙钟——消掉它们即是省下这部分`
    );
  }

  // 「推理占产出 80%」那条提示已删（作者裁定 2026-08-13）：思考占比高是深度思考档位的
  // 正常形态，不是故障，而它每跑一次就跳出来劝人降档——把一个作者已经做过的选择
  // 反复质疑一遍。占比本身仍在页脚数字里看得到，需要时自己判断即可。
  // 真正的异常（尝试白跑、实际档位低于请求、输出顶在 maxTokens）各有专条，不受影响。

  if (report.downgraded > 0) {
    findings.push(`${report.downgraded} 次调用的实际档位低于请求档位——请求的档位在这个模型上拿不到正文`);
  }

  // 触顶优先于「未正常结束」：有 output≈maxTokens 这个硬证据时，病因就不再是未知的，
  // 也**不该**再说一遍「服务商截断」——天花板是我们自己设的，动作是去改配置，不是去找服务商。
  if (report.ceilingHits > 0) {
    const budgets = [...new Set(ceilingValues)].sort((a, b) => a - b).join("/");
    findings.push(
      `${report.ceilingHits} 次调用的 output 顶在自己配置的 maxTokens=${budgets} 上——`
      + `这是本地输出预算被耗尽，不是服务商行为。抬高该模型的 maxTokens，或降思考档位`
    );
  } else if (report.incomplete > 0) {
    // 没有预算可比时只能如实说不知道。pi-ai 把所有 status=incomplete 都映射成
    // stopReason="length"（不读 incomplete_details），据此断言「被截断」就是编造。
    findings.push(
      `${report.incomplete} 次调用未正常结束（stopReason=length）——**原因未知**：`
      + `该字段是所有 incomplete 的统一映射，证明不了是截断。给模型配上 maxTokens 才能分辨`
    );
  }

  if (sampleCount >= MIN_SAMPLES_FOR_FINDING && report.cacheHitRatio === 0 && report.input > 0) {
    findings.push("前缀缓存命中为零：静态前缀没有被复用，按 EX-05 的假设它应该随章节增长");
  }

  return findings;
}

/**
 * 一个标签（通常是一章）的花销。
 *
 * 聚合总量回答不了「钱花在哪」：UI 页脚此前只有 input/output/cacheRead/cacheWrite
 * 四个数字，用户看到「输出 81166」既不知道哪一章吃掉的，也不知道其中多少是思考、
 * 多少是废在没交付结果的尝试上——而这两块正是最贵的部分。
 */
export interface UsageGroup {
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
  /** 与 {@link UsageReport.reasoningBasis} 同义：本组占比用的口径 */
  reasoningBasis: "tokens" | "chars";
  ceilingHits: number;
  wastedByKind: Record<string, number>;
  effectiveThinking: Record<string, number>;
}

/** 按标签分组，**花得多的排前面**——用户第一眼要看的就是最贵的那一项 */
export function groupUsageByLabel(rows: ReadonlyArray<UsageRecord>): UsageGroup[] {
  const byLabel = new Map<string, UsageRecord[]>();
  for (const row of rows) {
    const list = byLabel.get(row.label);
    if (list) list.push(row);
    else byLabel.set(row.label, [row]);
  }
  const groups: UsageGroup[] = [];
  for (const [label, list] of byLabel) {
    const wasted = list.filter((row) => !row.ok);
    const wastedByKind: Record<string, number> = {};
    for (const row of wasted) {
      const kind = row.errorKind ?? "unknown";
      wastedByKind[kind] = (wastedByKind[kind] ?? 0) + 1;
    }
    const effectiveThinking: Record<string, number> = {};
    for (const row of list) {
      if (!row.thinking) continue;
      effectiveThinking[row.thinking] = (effectiveThinking[row.thinking] ?? 0) + 1;
    }
    const sum = (pick: (row: UsageRecord) => number): number => list.reduce((total, row) => total + pick(row), 0);
    const reasoningChars = sum((row) => row.reasoningChars ?? 0);
    const textChars = sum((row) => row.textChars ?? 0);
    const reasoningTokens = sum((row) => row.reasoning ?? 0);
    const output = sum((row) => row.output);
    groups.push({
      label,
      attempts: list.length,
      wastedAttempts: wasted.length,
      ms: sum((row) => row.ms),
      input: sum((row) => row.input),
      cacheRead: sum((row) => row.cacheRead),
      output,
      wastedOutput: wasted.reduce((total, row) => total + row.output, 0),
      reasoningChars,
      textChars,
      reasoningRatio: reasoningTokens > 0 ? ratio(reasoningTokens, output) : ratio(reasoningChars, reasoningChars + textChars),
      reasoningBasis: reasoningTokens > 0 ? "tokens" : "chars",
      ceilingHits: list.filter((row) => row.maxTokens !== undefined && row.output >= row.maxTokens * CEILING_TOLERANCE).length,
      wastedByKind,
      effectiveThinking,
    });
  }
  return groups.sort((a, b) => b.output - a.output);
}

/** 渲染成人能读的一段文本。只有数字与档位名，正文在结构上进不来 */
export function renderUsageReport(report: UsageReport): string {
  const lines = [
    `尝试 ${report.attempts} 次（废 ${report.wastedAttempts} · ${pct(report.wastedRatio)}）· 墙钟 ${Math.round(report.ms / 1000)}s（其中废掉 ${Math.round(report.wastedMs / 1000)}s）`,
    `输入 ${report.input}（命中缓存 ${report.cacheRead} · ${pct(report.cacheHitRatio)}）· 输出 ${report.output}（废掉 ${report.wastedOutput}）`,
    `推理占产出 ${pct(report.reasoningRatio)}（${basisLabel(report.reasoningBasis)}）· 降档 ${report.downgraded} 次 · 未正常结束 ${report.incomplete} 次（触顶 ${report.ceilingHits}）`,
  ];
  const kinds = Object.entries(report.wastedByKind).sort((a, b) => b[1] - a[1]);
  if (kinds.length > 0) lines.push(`废因：${kinds.map(([kind, count]) => `${kind} ×${count}`).join(" · ")}`);
  const levels = Object.entries(report.effectiveThinking).sort((a, b) => b[1] - a[1]);
  if (levels.length > 0) lines.push(`生效档位：${levels.map(([level, count]) => `${level} ×${count}`).join(" · ")}`);
  if (report.findings.length > 0) lines.push("", ...report.findings.map((finding) => `• ${finding}`));
  return lines.join("\n");
}
