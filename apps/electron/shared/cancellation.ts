/**
 * 长任务取消（RH-16 / 架构评估 A-3）。
 *
 * 取消的发起点与收尾点都在 IPC 层：`translate.cancel` / `bookReview.cancel` abort 对应的
 * AbortController，包在 LLM 桥外面的代理在下一次调用前（或正在飞行的 fetch 上）抛出
 * `CancelledError`，管线随之退栈，IPC 层再把章节状态归位到 ready。
 *
 * 取消不是错误：它不该被 retryCall 当作瞬态失败退避重试，也不该被当作 internal 上报。
 */
export class CancelledError extends Error {
  constructor(message = "已取消") {
    super(message);
    this.name = "CancelledError";
  }
}

export function isCancelledError(error: unknown): boolean {
  if (error instanceof CancelledError) return true;
  // fetch 在 signal abort 时抛的是 DOMException/AbortError
  const name = (error as { name?: string } | null)?.name;
  return name === "CancelledError" || name === "AbortError";
}
