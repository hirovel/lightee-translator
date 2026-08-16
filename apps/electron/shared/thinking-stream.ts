/**
 * 思考增量的攒批缓冲（TR-03）。
 *
 * `thinking_delta` 是逐小块到达的：一次翻译几万字符思考意味着上万条 IPC 消息，
 * 而渲染层每秒能消化的更新远少于此。所以主进程与渲染层之间要有个缓冲，
 * 按**时间窗**与**体积**双阈值合并，到点才发一条。
 *
 * ## 为什么两个阈值都要
 *
 * 只按时间窗：思考爆发时一个窗口能攒下几千字符，一条巨型消息卡住渲染。
 * 只按体积：思考稀疏时最后那点内容会一直等不到阈值，界面上像是卡死了。
 *
 * ## 红线
 *
 * 缓冲里流的是思考内容，含原文与译文草稿。它只走**进程内 → 渲染层**这一条路，
 * **不得**进 usage.jsonl（那里只记 reasoningChars 长度）与 AppLog。
 */

/** 攒批参数。默认值取「人眼刚好看得出在动、又不至于打满 IPC」的量级 */
export interface ThinkingBufferOptions {
  /** 时间窗（ms）：窗口到点即冲刷 */
  windowMs?: number;
  /** 体积阈值（字符）：攒够即刻冲刷，不等窗口 */
  maxChars?: number;
}

const DEFAULT_WINDOW_MS = 80;
const DEFAULT_MAX_CHARS = 400;

/** 冲刷回调。`done=true` 表示这个思考块结束了，渲染层据此把打字机停下 */
export type ThinkingSink = (text: string, done: boolean) => void;

export class ThinkingBuffer {
  private pending = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private finished = false;
  private readonly windowMs: number;
  private readonly maxChars: number;

  constructor(private readonly sink: ThinkingSink, options: ThinkingBufferOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  }

  push(delta: string): void {
    // 已结束还收到 delta：丢弃。迟到的增量不该复活一个已经收尾的块，
    // 否则渲染层会看到「结束 → 又开始动」的鬼影。
    if (this.finished || !delta) return;
    this.pending += delta;
    if (this.pending.length >= this.maxChars) {
      this.flush(false);
      return;
    }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => { this.timer = undefined; this.flush(false); }, this.windowMs);
    }
  }

  /**
   * 收尾：把尾巴冲出去并标记结束。
   *
   * **即使没有待发内容也要发一条 `done`**——渲染层靠它把打字机停下，
   * 少了它界面会永远停在「正在思考」上。
   */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.clearTimer();
    this.emit(this.pending, true);
    this.pending = "";
  }

  private flush(done: boolean): void {
    if (!this.pending) return;
    const text = this.pending;
    this.pending = "";
    this.emit(text, done);
  }

  private emit(text: string, done: boolean): void {
    // 下游异常吞掉：与账本写失败、onThinking 回调异常同一个取舍——
    // 辅助设施的故障不该升级成主流程的故障。
    try { this.sink(text, done); } catch { /* 展示层异常：吞掉 */ }
  }

  private clearTimer(): void {
    // 留着未触发的定时器会拖住事件循环，让进程迟迟不退出——关窗排空时这会变成一个卡顿。
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
  }
}
