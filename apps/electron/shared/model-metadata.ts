/**
 * 服务商 `/models` 返回里的模型元数据解析。
 *
 * 规则只有一条：**有就读，没有就不猜**。上下文窗口直接决定要不要把整本书注入上下文
 * （`bookContextBudget`）、以及 Manager 什么时候开始压缩——猜错一个数，代价落在每一次调用的
 * 成本或质量上，而不是一处显示错误。所以任何拿不准的形态一律返回 undefined，交回给用户手填。
 */

/** 同一件事的不同叫法：OpenAI 兼容端点各家没统一过 */
const CONTEXT_FIELDS = ["context_length", "context_window", "max_context_length", "max_model_len", "context_size"] as const;

/**
 * 合理区间。低于 1k 多半不是窗口（把别的字段当成了它），高于 100M 同理。
 * 上界留得比任何现役模型都宽——这条是防呆，不是产品判断。
 */
const MIN_CONTEXT = 1_024;
const MAX_CONTEXT = 100_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 数字或纯数字串 → 正整数；其余一律 undefined */
function positiveInt(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value
    : (typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_CONTEXT || parsed > MAX_CONTEXT) return undefined;
  return parsed;
}

/**
 * 从一条 `/models` 条目里读上下文窗口（token）。
 * 顶层字段优先；OpenRouter 那种嵌在 `top_provider` 里的写法作为回退。
 */
export function readContextLength(entry: unknown): number | undefined {
  if (!isRecord(entry)) return undefined;
  for (const field of CONTEXT_FIELDS) {
    const value = positiveInt(entry[field]);
    if (value !== undefined) return value;
  }
  const nested = entry.top_provider;
  if (isRecord(nested)) {
    for (const field of CONTEXT_FIELDS) {
      const value = positiveInt(nested[field]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}
