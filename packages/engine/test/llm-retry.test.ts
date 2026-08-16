import { describe, expect, test } from "vitest";
import {
  isRetryableError,
  isContextOverflowError,
  retryCall,
  errorMessageOf,
} from "../src/llm-retry.ts";

// ===== 1. 错误分类（照搬 pi pattern）=====
describe("isRetryableError", () => {
  test("瞬态 provider 错误 → 可重试", () => {
    expect(isRetryableError("upstream error: 429 Too Many Requests")).toBe(true);
    expect(isRetryableError("The server is overloaded, please try again")).toBe(true);
    expect(isRetryableError("HTTP 502 Bad Gateway")).toBe(true);
    expect(isRetryableError("503 service unavailable")).toBe(true);
    expect(isRetryableError("internal server error")).toBe(true);
    expect(isRetryableError("fetch failed: connection refused")).toBe(true);
    expect(isRetryableError("socket hang up")).toBe(true);
    expect(isRetryableError("request timed out")).toBe(true);
    expect(isRetryableError("getaddrinfo ENOTFOUND api.example.com")).toBe(true);
    expect(isRetryableError("stream ended before message_stop")).toBe(true);
    expect(isRetryableError("rate limit exceeded: retry delay")).toBe(true);
    expect(isRetryableError("upstream connect error")).toBe(true);
    expect(isRetryableError("ResourceExhausted")).toBe(true);
  });

  test("quota/计费耗尽 → 不可重试（快速失败）", () => {
    expect(isRetryableError("insufficient_quota: you exceeded your current quota")).toBe(false);
    expect(isRetryableError("out of budget")).toBe(false);
    expect(isRetryableError("quota exceeded")).toBe(false);
    expect(isRetryableError("billing issue on your account")).toBe(false);
    expect(isRetryableError("Monthly usage limit reached")).toBe(false);
    expect(isRetryableError("GoUsageLimitError")).toBe(false);
    expect(isRetryableError("available balance is insufficient")).toBe(false);
  });

  test("上下文溢出 → 不可重试（转降批/报错）", () => {
    expect(isRetryableError("This model's maximum context length is 131072 tokens")).toBe(false);
    expect(isRetryableError("prompt is too long")).toBe(false);
    expect(isRetryableError("context window exceeded")).toBe(false);
    expect(isRetryableError("length-stop: maximum output tokens reached")).toBe(false);
  });

  test("未知错误 / 空消息 → 不可重试", () => {
    expect(isRetryableError("")).toBe(false);
    expect(isRetryableError("some random error")).toBe(false);
    expect(isRetryableError("模型不存在: x/y")).toBe(false);
  });

  test("isContextOverflowError 判定", () => {
    expect(isContextOverflowError("maximum context length exceeded")).toBe(true);
    expect(isContextOverflowError("rate limit")).toBe(false);
  });
});

// ===== 2. retryCall 循环 =====
describe("retryCall", () => {
  test("成功立即返回（零重试）", async () => {
    let calls = 0;
    const r = await retryCall(async () => {
      calls++;
      return "ok";
    }, errorMessageOf);
    expect(r).toBe("ok");
    expect(calls).toBe(1);
  });

  test("瞬态错误 → 指数退避重试至成功（2 次失败后成功）", async () => {
    let calls = 0;
    const delays: number[] = [];
    const events: string[] = [];
    const r = await retryCall(
      async () => {
        calls++;
        if (calls <= 2) {
          const e = new Error("503 service unavailable") as Error & { errorMessage?: string };
          e.errorMessage = "503 service unavailable";
          throw e;
        }
        return "ok";
      },
      errorMessageOf,
      {
        policy: { maxRetries: 3, baseDelayMs: 100 },
        callbacks: {
          onRetryScheduled: (a, m, d) => {
            delays.push(d);
            events.push(`sched${a}`);
          },
          onRetryAttemptStart: (a) => events.push(`start${a}`),
          onRetryFinished: (ok, a) => events.push(`fin${ok}:${a}`),
        },
      }
    );
    expect(r).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]); // 2s 4s 的等比
    expect(events).toEqual(["sched1", "start1", "sched2", "start2", "fintrue:2"]);
  });

  test("瞬态错误超预算 → 抛最终错误（3 次重试后失败）", async () => {
    let calls = 0;
    await expect(
      retryCall(
        async () => {
          calls++;
          const e = new Error("connection refused") as Error & { errorMessage?: string };
          e.errorMessage = "connection refused";
          throw e;
        },
        errorMessageOf,
        { policy: { maxRetries: 2, baseDelayMs: 10 } }
      )
    ).rejects.toThrow("connection refused");
    expect(calls).toBe(3); // 1 原调用 + 2 重试
  });

  test("quota 错误 → 立即抛（零重试）", async () => {
    let calls = 0;
    await expect(
      retryCall(async () => {
        calls++;
        throw new Error("insufficient_quota");
      }, errorMessageOf)
    ).rejects.toThrow("insufficient_quota");
    expect(calls).toBe(1);
  });

  test("上下文溢出 → 立即抛（零重试）", async () => {
    let calls = 0;
    await expect(
      retryCall(async () => {
        calls++;
        throw new Error("maximum context length exceeded");
      }, errorMessageOf)
    ).rejects.toThrow("maximum context length");
    expect(calls).toBe(1);
  });

  test("abort → 终止不重试（退避中中断）", async () => {
    let calls = 0;
    const ac = new AbortController();
    let finished = false;
    const p = retryCall(
      async () => {
        calls++;
        if (calls === 1) {
          const e = new Error("500 server error") as Error & { errorMessage?: string };
          e.errorMessage = "500 server error";
          throw e;
        }
        return "ok";
      },
      errorMessageOf,
      {
        policy: { maxRetries: 3, baseDelayMs: 1000 },
        signal: ac.signal,
        callbacks: { onRetryFinished: () => { finished = true; } },
      }
    );
    // 等第一次失败 + 退避开始，然后 abort
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    await expect(p).rejects.toThrow("500 server error");
    expect(calls).toBe(1); // 没有重试调用
    expect(finished).toBe(true); // onRetryFinished 照常触发
  });

  test("policy.enabled=false → 零重试", async () => {
    let calls = 0;
    await expect(
      retryCall(async () => {
        calls++;
        throw new Error("fetch failed");
      }, errorMessageOf, { policy: { enabled: false } })
    ).rejects.toThrow("fetch failed");
    expect(calls).toBe(1);
  });
});

// ===== 3. errorMessageOf =====
describe("errorMessageOf", () => {
  test("优先取 errorMessage 字段", () => {
    const e = { errorMessage: "429 rate limit" } as unknown as Error;
    expect(errorMessageOf(e)).toBe("429 rate limit");
  });
  test("回退 Error.message", () => {
    expect(errorMessageOf(new Error("503"))).toBe("503");
  });
  test("未知 → undefined", () => {
    expect(errorMessageOf(undefined)).toBeUndefined();
    expect(errorMessageOf("string-error")).toBe("string-error");
  });
});
