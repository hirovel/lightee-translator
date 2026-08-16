/**
 * Agent 控制台「轨迹」视图的纯函数层（UI-9，界面语言借鉴 deepseek-harness 的
 * trajectory 查看器，MIT；本文件是原生重实现，不含其代码）。
 *
 * 对齐其源码规格（packages/client/ui-trajectory）：分轨时间线（模型轨/工具轨，
 * 对应其 Model/Tools lane；Lightee 的账本没有独立的输入事件，Input 轨如实省略）、
 * 「真实时长 / 等宽」两种布局（其 Duration 开关）、搜索不命中降透明度。
 *
 * 口径纪律：统计条只放**能从 agent.log 证明**的数字——
 * 逐 token 首字延迟、工具执行耗时这些账本里没有的量，一个都不编。
 */
import type { LlmUsageSnapshot } from "../../../shared/ipc-contract";

export interface TraceEntryInput {
  id: string;
  label?: string;
  ok: boolean;
  ms: number;
  ts: number;
  toolCallCount?: number;
  usage?: LlmUsageSnapshot;
}

export type TraceKind = "ok" | "err" | "tool";
/** 其 Duration 开关的两种布局：按真实时长铺轴 / 每次调用等宽（毫秒级调用也看得见） */
export type TraceLayoutMode = "actual" | "equal";

export interface TraceSegment {
  id: string;
  kind: TraceKind;
  /** 0=模型轨（纯文本轮），1=工具轨（带工具调用的轮）——对应其 Model/Tools lane */
  lane: 0 | 1;
  /** 相对整条轨迹的起点/宽度（0..100，百分比） */
  leftPct: number;
  widthPct: number;
}

/** 时间线：按真实起止时间（或等宽）铺色块。空账本 → 空数组（没有数据就不画轴）。 */
export function traceTimeline(entries: readonly TraceEntryInput[], mode: TraceLayoutMode = "actual"): TraceSegment[] {
  if (entries.length === 0) return [];
  // agent.log.list 返回新→旧；时间线按旧→新铺
  const ordered = [...entries].sort((a, b) => a.ts - b.ts);
  const classify = (entry: TraceEntryInput): Pick<TraceSegment, "kind" | "lane"> => ({
    kind: !entry.ok ? "err" : entry.toolCallCount ? "tool" : "ok",
    lane: entry.toolCallCount ? 1 : 0,
  });
  if (mode === "equal") {
    const slot = 100 / ordered.length;
    return ordered.map((entry, index) => ({
      id: entry.id,
      ...classify(entry),
      leftPct: index * slot,
      // 等宽块之间留 12% 的槽内空隙作视觉分隔
      widthPct: Math.max(0.4, slot * 0.88),
    }));
  }
  const start = ordered[0]!.ts;
  const end = Math.max(...ordered.map((entry) => entry.ts + Math.max(0, entry.ms)));
  const span = Math.max(1, end - start);
  const MIN_WIDTH_PCT = 0.6; // 短调用给可点击的最小宽度，否则毫秒级调用在轴上不可见
  return ordered.map((entry) => {
    const leftPct = ((entry.ts - start) / span) * 100;
    const widthPct = Math.max(MIN_WIDTH_PCT, (Math.max(0, entry.ms) / span) * 100);
    return {
      id: entry.id,
      ...classify(entry),
      leftPct: Math.min(leftPct, 100 - MIN_WIDTH_PCT),
      widthPct: Math.min(widthPct, 100),
    };
  });
}

/**
 * 搜索匹配（其规格：空格分词，全部词均需子串命中，不区分大小写）。
 * haystack 由调用方拼（标签/模型/预览文本），这里只管判定。
 */
export function traceSearchMatch(haystack: string, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const target = haystack.toLowerCase();
  return terms.every((term) => target.includes(term));
}

/** 底部统计条。只报账本里真实存在的量；无数据的段落整个不出现。 */
export function traceStats(entries: readonly TraceEntryInput[], totals: LlmUsageSnapshot | undefined): string {
  if (entries.length === 0) return "";
  const failed = entries.filter((entry) => !entry.ok).length;
  const toolRounds = entries.filter((entry) => Boolean(entry.toolCallCount)).length;
  const llmMs = entries.reduce((sum, entry) => sum + Math.max(0, entry.ms), 0);
  const parts: string[] = [
    `${entries.length} 次调用${failed ? `（失败 ${failed}）` : ""}${toolRounds ? ` · 工具轮 ${toolRounds}` : ""}`,
    `LLM 耗时 ${formatTraceMs(llmMs)}`,
  ];
  if (totals) {
    const prompt = totals.input + (totals.cacheRead ?? 0) + (totals.cacheWrite ?? 0);
    if (prompt > 0) parts.push(`缓存命中 ${(((totals.cacheRead ?? 0) / prompt) * 100).toFixed(0)}%`);
    parts.push(`输入 ${formatTraceTokens(totals.input + (totals.cacheRead ?? 0) + (totals.cacheWrite ?? 0))} tok · 输出 ${formatTraceTokens(totals.output)} tok`);
  }
  return parts.join("　|　");
}

export function formatTraceMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
}

export function formatTraceTokens(count: number): string {
  return count >= 10_000 ? `${(count / 1000).toFixed(1)}K` : String(count);
}
