/**
 * LLM 调用重试 —— 照搬 pi 的 retry 规则（@earendil-works/pi-ai/utils/retry.js + agent-session）。
 *
 * 规则（与 pi 一致）:
 *  - 错误分类: stopReason error + errorMessage 匹配 → 可重试/不可重试
 *    - 不可重试（quota/billing 耗尽）: insufficient_quota / out of budget / quota exceeded /
 *      billing / available balance / GoUsageLimitError / FreeUsageLimitError / Monthly usage limit…
 *    - 可重试（瞬态）: overloaded / rate limit / too many requests / 429 / 5xx / 524 /
 *      service unavailable / server error / internal error / network / connection / fetch failed /
 *      ENOTFOUND / EAI_AGAIN / timeout / socket hang up / stream ended / ResourceExhausted 等
 *    - 上下文溢出 → 不重试（上层降批/报错）
 *  - 预算: maxRetries=3 · baseDelayMs=2000 → 指数退避 2s/4s/8s
 *  - abort: 终止且不重试（退避中 abort 同样终止）
 *  - 成功立即返回（无重试）
 */

export interface RetryPolicy {
  enabled?: boolean;
  maxRetries?: number;
  baseDelayMs?: number;
}

export interface RetryCallbacks {
  onRetryScheduled?: (attempt: number, maxAttempts: number, delayMs: number, errorMessage: string) => void;
  onRetryAttemptStart?: (attempt: number) => void;
  onRetryFinished?: (success: boolean, attempt: number, errorMessage?: string) => void;
}

/** 上下文溢出 → 不重试（转 compaction/降批），照搬 pi isContextOverflow 的判定思路 */
export function isContextOverflowError(errorMessage: string): boolean {
  return (
    /context length|context window|maximum context|too many tokens|token limit|length[- ]?stop|prompt is too long|max_tokens.*exceeded/i.test(
      errorMessage
    )
  );
}

const NON_RETRYABLE_PROVIDER_LIMIT_PATTERN =
  /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;

/** 认证/授权错误 → 快速失败（不重试，提示检查密钥） */
const AUTH_ERROR_PATTERN =
  /invalid api key|api key.*invalid|unauthorized|authentication failed|auth.?fail|401|403|invalid token|permission denied|forbidden/i;

const RETRYABLE_PROVIDER_ERROR_PATTERN =
  /overloaded|rate.?limit|too many requests|429|500|502|503|504|524|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? out|timeout|terminated|websocket.?closed|websocket.?error|ended without|stream ended before message_stop|stream ended before a terminal response event|http2 request did not get a response|retry delay|you can retry your request|try your request again|please retry your request|ResourceExhausted/i;

/** 分类：errorMessage 是否可重试（quota/溢出 → false） */
export function isRetryableError(errorMessage: string): boolean {
  if (!errorMessage) return false;
  if (isContextOverflowError(errorMessage)) return false;
  if (NON_RETRYABLE_PROVIDER_LIMIT_PATTERN.test(errorMessage)) return false;
  return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}

/** 结构化错误分类（贯穿到上层：处理策略 + 用户可见文案） */
export type LlmErrorKind =
  | "transient" // 瞬态：429/5xx/网络/超时（已按 pi 规则重试耗尽后到达这里）
  | "quota" // 配额/账单/余额不足 → 快速失败，提示充值/换 key
  | "auth" // 密钥无效/未授权 → 快速失败，提示检查 AI 设置
  | "context_overflow" // 上下文/ token 超限 → 快速失败，不重试（上层降批）
  | "empty" // 模型返回空响应（降档链已处理后残余）
  | "unknown";

export interface LlmErrorInfo {
  kind: LlmErrorKind;
  message: string;
  retryable: boolean;
}

/** 分类一个 LLM 错误（优先级：quota > 溢出 > auth > empty > 瞬态 > 未知） */
export function classifyLlmError(error: unknown): LlmErrorInfo {
  const message = errorMessageOf(error) ?? String(error ?? "");
  if (NON_RETRYABLE_PROVIDER_LIMIT_PATTERN.test(message)) return { kind: "quota", message, retryable: false };
  if (isContextOverflowError(message)) return { kind: "context_overflow", message, retryable: false };
  if (AUTH_ERROR_PATTERN.test(message)) return { kind: "auth", message, retryable: false };
  if (/模型返回空响应|空响应/.test(message)) return { kind: "empty", message, retryable: true };
  if (RETRYABLE_PROVIDER_ERROR_PATTERN.test(message)) return { kind: "transient", message, retryable: true };
  return { kind: "unknown", message, retryable: false };
}

/** 给错误附加结构化分类（供上层 catch 分流） */
export function attachErrorKind(error: unknown): unknown {
  const info = classifyLlmError(error);
  if (error && typeof error === "object" && !("kind" in (error as object))) {
    try {
      (error as { kind?: LlmErrorKind }).kind = info.kind;
      (error as { retryable?: boolean }).retryable = info.retryable;
    } catch {
      // 只读错误对象 → 不附加（不影响主流程）
    }
  }
  return error;
}

export class RetrySleepAbortError extends Error {
  constructor() {
    super("Aborted");
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RetrySleepAbortError());
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new RetrySleepAbortError());
      },
      { once: true }
    );
  });
}

export interface RetryOptions {
  policy?: RetryPolicy;
  signal?: AbortSignal;
  callbacks?: RetryCallbacks;
}

/** 带界重试的一次性调用（照搬 pi retryAssistantCall）:
 *  成功立即返回；abort 终止不重试；quota/溢出/非瞬态错误立即抛；瞬态错误指数退避重试至预算耗尽。 */
export async function retryCall<T>(
  produce: () => Promise<T>,
  errorMessageOf: (e: unknown) => string | undefined,
  options: RetryOptions = {}
): Promise<T> {
  const policy = options.policy ?? {};
  const maxAttempts = policy.enabled === false ? 0 : (policy.maxRetries ?? 3);
  const baseDelayMs = policy.baseDelayMs ?? 2000;
  let attempt = 0;
  let lastRetry: { attempt: number; errorMessage: string } | undefined;

  for (;;) {
    try {
      const result = await produce();
      if (lastRetry) options.callbacks?.onRetryFinished?.(true, lastRetry.attempt);
      return result;
    } catch (error) {
      const errorMessage = errorMessageOf(error) ?? (error instanceof Error ? error.message : String(error));
      if (options.signal?.aborted) {
        if (lastRetry) options.callbacks?.onRetryFinished?.(false, lastRetry.attempt, errorMessage);
        throw error; // abort 终止且不重试
      }
      if (attempt >= maxAttempts || !isRetryableError(errorMessage)) {
        if (lastRetry) options.callbacks?.onRetryFinished?.(false, lastRetry.attempt, errorMessage);
        throw error; // 预算耗尽或确定性错误，快速失败
      }
      attempt++;
      lastRetry = { attempt, errorMessage };
      const delayMs = baseDelayMs * 2 ** (attempt - 1); // 2s / 4s / 8s
      options.callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, errorMessage);
      try {
        await sleep(delayMs, options.signal);
      } catch {
        options.callbacks?.onRetryFinished?.(false, attempt, errorMessage);
        throw error; // 退避中被 abort → 终止
      }
      options.callbacks?.onRetryAttemptStart?.(attempt);
    }
  }
}

/** 便捷：LLM 调用错误 → errorMessage 提取（stream 错误事件带 errorMessage 字段） */
export function errorMessageOf(error: unknown): string | undefined {
  if (error && typeof error === "object" && "errorMessage" in error) {
    const em = (error as { errorMessage?: unknown }).errorMessage;
    if (typeof em === "string" && em) return em;
  }
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' && error) return error;
  return undefined;
}
