/**
 * 思考展示的纯逻辑（TR-04）。
 *
 * 分出这个模块与 `model-indicator.ts` / `export-composition.ts` 同一个理由：
 * 渲染层的 vitest 跑在 node 环境（无 DOM），能被钉死的只有纯函数。
 * DOM 读写留在 workspace-bridge，这里只回答「该显示什么」。
 *
 * ## 它要解决的问题
 *
 * 此前运行中的界面上只有一个转圈的秒表。于是「正常地慢」与「卡在第 3 次重试」
 * 长得一模一样——2026-08-12 的跑批里 ch003 连废三次、耗掉 380 秒，
 * 用户能看到的只有一个一直在涨的数字。
 *
 * 顺带一个副作用是好事：思考一旦可见，模型「把原文抄进思考里先译一遍」
 * 这种行为（实测思考 13447 字符 / 正文 174 字符）会当着人的面暴露出来。
 */

/** 一条 `agent.thinking` 事件里我们关心的部分 */
export interface ThinkingEvent {
  label: string;
  attempt?: number;
  thinking?: string;
  delta: string;
  done?: boolean;
}

export interface ThinkingState {
  label: string;
  attempt: number;
  thinking?: string;
  /** 本块累积的思考全文 */
  text: string;
  chars: number;
  done: boolean;
  /** 本块开始的时刻（换块即重置） */
  startedAt: number;
}

export function emptyThinking(): ThinkingState {
  return { label: "", attempt: 0, text: "", chars: 0, done: false, startedAt: 0 };
}

/**
 * 累积一条事件。
 *
 * **换 label 或换 attempt 即换块**：上一章的思考不该出现在这一章下面，
 * 重来一次也该从头显示——把两次的思考粘在一起，字符数就成了假数。
 */
export function reduceThinking(state: ThinkingState, event: ThinkingEvent, now: number): ThinkingState {
  const attempt = event.attempt ?? 1;
  const fresh = state.label !== event.label || state.attempt !== attempt;
  if (fresh) {
    return {
      label: event.label,
      attempt,
      ...(event.thinking ? { thinking: event.thinking } : {}),
      text: event.delta,
      chars: event.delta.length,
      done: event.done === true,
      startedAt: now,
    };
  }
  // 已收尾还收到增量：丢弃。迟到的 delta 不该让一个已经结束的块又动起来。
  if (state.done) return state;
  const text = state.text + event.delta;
  return {
    ...state,
    ...(event.thinking ? { thinking: event.thinking } : {}),
    text,
    chars: text.length,
    done: event.done === true,
  };
}

export interface ThinkingViewOptions {
  /** 打字机尾巴显示多少字符 */
  tailChars?: number;
}

export interface ThinkingView {
  visible: boolean;
  running: boolean;
  /** 打字机那一行：思考的最后一小段，换行已折成空格 */
  tail: string;
  /** 折叠态那一行：字符数 + 档位 + 重试次数 */
  summary: string;
}

const DEFAULT_TAIL_CHARS = 60;

/** 千分位。13447 这种数字直接糊在句子里读不出量级 */
const groupDigits = (value: number): string => value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function describeThinking(state: ThinkingState, options: ThinkingViewOptions = {}): ThinkingView {
  if (!state.label) return { visible: false, running: false, tail: "", summary: "" };
  const tailChars = options.tailChars ?? DEFAULT_TAIL_CHARS;
  // 打字机是**一行**。多行会把卡片撑开又缩回，闪得没法看。
  const flat = state.text.replace(/\s+/g, " ").trimStart();
  const tail = flat.length > tailChars ? flat.slice(-tailChars) : flat;
  const parts = [`思考 ${groupDigits(state.chars)} 字符`];
  if (state.thinking) parts.push(state.thinking);
  // 第 1 次不写次数：没重试就别制造「出事了」的暗示。第 2 次起必须露脸——
  // 少了它，「正常地慢」和「卡在第 3 次重试」在用户眼里完全一样。
  if (state.attempt > 1) parts.push(`第 ${state.attempt} 次`);
  return { visible: true, running: !state.done, tail, summary: parts.join(" · ") };
}
