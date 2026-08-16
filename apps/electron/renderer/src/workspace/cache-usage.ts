/**
 * 缓存用量的展示口径（R0-2 / architecture-roadmap A3）。
 *
 * 抽成纯函数模块的理由和 `model-indicator.ts` 相同：口径本身要能被单测钉死。
 * 缓存命中率算错不会报错，只会让用户按一个假数字判断成本——这正是 A3 要防的
 * 「静默失效让用户多花十倍钱而不自知」。
 *
 * **分母的依据**（查 pi-ai 源码得出，非推测）：`usage.input` 已经剔除了缓存命中与
 * 缓存写入部分——`dist/api/openai-completions.js:1075` 是
 * `Math.max(0, prompt_tokens - cacheRead - cacheWrite)`，`dist/api/openai-responses-shared.js:428`
 * 同式。所以四个字段互不重叠，提示词总量 = `input + cacheRead + cacheWrite`，
 * 命中率 = `cacheRead ÷ 提示词总量`。若误用 `input` 当全部输入，命中率会被高估。
 */
import type { LlmUsageSnapshot } from "../../../shared/ipc-contract";

/** 口径标注：算法可复核，但与服务商账单之间还隔着计价规则与取整，不承诺对账一致 */
export const CACHE_RATE_NOTE = "近似值，以服务商账单为准";

/** 页脚命中率的 title：把分母摊开写，用户才能判断这个数字能不能拿来对账 */
export const CACHE_RATE_TITLE = `缓存命中率 = 缓存读 ÷（输入 + 缓存读 + 缓存写）。${CACHE_RATE_NOTE}`;

/** 逐条缓存摘要的悬停解释——「命中/新存」对非从业者不是自明词，鼠标停上去要能看懂 */
export const CALL_CACHE_TITLE =
  "缓存命中：这次请求里复用了之前请求开头部分的 token 数（这部分服务商按大约一折计费）。命中 0 = 这次没吃到缓存，全价。新存：本次新写入缓存、供后续请求复用的 token 数。";

/**
 * 单次调用的缓存摘要。
 *
 * `命中 0` 照样显示——它正是「这次调用打穿了前缀」的证据，藏起来等于把要找的东西藏起来。
 * 但「写 0」不再常驻：多数服务商（如 DeepSeek）不单独上报缓存写入，把未上报渲染成
 * 「写 0」既是撒谎（没有数据 ≠ 数据为零）也是噪音——用户看一整屏「写 0」只会困惑。
 * 新存只在服务商真实上报且 > 0 时出现。
 */
export function formatCallCache(usage: LlmUsageSnapshot | undefined): string | null {
  if (!usage) return null;
  const read = usage.cacheRead;
  const write = usage.cacheWrite;
  if (read === undefined && write === undefined) return "缓存未上报";
  const hit = read === undefined ? "缓存命中未上报" : `缓存命中 ${read}`;
  return write !== undefined && write > 0 ? `${hit} · 新存 ${write}` : hit;
}

/** 缓存命中率（0..1）；提示词总量为 0（尚未调用）时返回 null，不拿 0% 冒充「全部未命中」 */
export function cacheHitRate(totals: LlmUsageSnapshot | undefined): number | null {
  if (!totals) return null;
  const prompt = totals.input + (totals.cacheRead ?? 0) + (totals.cacheWrite ?? 0);
  if (prompt <= 0) return null;
  return (totals.cacheRead ?? 0) / prompt;
}

/** 命中率文案；无数据时给横杠而不是 0% */
export function formatHitRate(totals: LlmUsageSnapshot | undefined): string {
  const rate = cacheHitRate(totals);
  return rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
}
