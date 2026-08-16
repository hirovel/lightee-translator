/**
 * 运行流水（会话式时间轴）的纯逻辑。
 *
 * 与 `thinking-view.ts` / `model-indicator.ts` 分出来的理由相同：渲染层的 vitest 跑在
 * node 环境（无 DOM），能被钉死的只有纯函数。DOM 读写留在 workspace-bridge，
 * 这里只回答「现在这一章走到哪一步了、之前经过了什么」。
 *
 * ## 它要解决的问题
 *
 * Agent 控制台是一个**扁平的调用列表**：一次翻译在里面是两条并排的记录，
 * 而这一章实际经历的是「配置 → 轮1思考 → 工具登记 → L0 判定回灌 → 轮2正文 →
 * 段落门禁 → 审校 → 状态迁移」。列表答得了「第 3 次调用花了多少 token」，
 * 答不了「刚才那两分钟系统在干什么」——而后者才是运行中的人真正在问的。
 *
 * ## 为什么阶段是**观测**出来的，不是编出来的
 *
 * 每一条 step 都由一条真实事件驱动（`agent.status` / `agent.thinking` /
 * `translate.progress` / `chapter.stateChanged` / `review.progress`）。
 * **没有事件就没有 step**：宁可时间轴上少一格，也不假装某一步发生过。
 * 「工具登记」与「判定回灌」这两步目前没有专属事件——它们夹在轮 1 思考结束与
 * 轮 2 思考开始之间，所以这里只呈现两个思考块之间的**间隔**，并如实标注
 * 「工具轮（无专属事件，按两次思考块的间隔推定）」，不写成一句确定的陈述。
 */

/** 时间轴上的一格。`at` 是相对本次运行起点的毫秒数——绝对时刻对读的人没有意义。 */
export interface TranscriptStep {
  /** 稳定 key，用于 DOM 复用与去重 */
  key: string;
  /** 阶段类型，决定图标与配色 */
  kind: "state" | "thinking" | "gap" | "progress" | "warning" | "review" | "done" | "failed";
  /** 一行标题 */
  title: string;
  /** 副行；没有就不显示 */
  detail?: string;
  /** 相对起点毫秒 */
  at: number;
  /** 本格还在进行中（思考块未收到 done 时为 true） */
  running?: boolean;
}

export interface TranscriptState {
  /** 本条流水属于哪一章。换章即换流水——上一章的步骤不该出现在这一章下面 */
  chapterId: string;
  startedAt: number;
  steps: TranscriptStep[];
  /** 未收尾的思考块（key → 起始时刻与累计字数） */
  openThinking: Record<string, { at: number; chars: number; thinking?: string; stepKey: string }>;
  /** 上一个思考块**收尾**的时刻。工具轮间隔靠它算 */
  lastThinkingEndedAt?: number;
  /** 整条流水是否已结束 */
  finished: boolean;
}

export function emptyTranscript(): TranscriptState {
  return { chapterId: "", startedAt: 0, steps: [], openThinking: {}, finished: false };
}

/** 进来的事件（只取我们关心的字段，形状照 IpcEventMap） */
export type TranscriptEvent =
  | { type: "agent.status"; agent?: string; status?: string; message?: string; kind?: string; chapterId?: string }
  | { type: "agent.thinking"; label?: string; attempt?: number; thinking?: string; delta?: string; done?: boolean; chapterId?: string }
  | { type: "translate.progress"; chapterId?: string; progress?: number; message?: string }
  | { type: "review.progress"; chapterId?: string; progress?: number; message?: string }
  | { type: "chapter.stateChanged"; chapterId?: string; from?: string; to?: string; reason?: string };

const STATE_LABELS: Record<string, string> = {
  imported: "已导入",
  ready: "待翻译",
  translating: "翻译中",
  translated: "已翻译",
  reviewing: "审校中",
  revising: "修订中",
  approved: "已定稿",
  stuck: "待作者处理",
};

/** 终态：到了这两个状态，这一章这一轮就结束了 */
const TERMINAL = new Set(["approved", "stuck"]);

function push(state: TranscriptState, step: TranscriptStep): TranscriptState {
  return { ...state, steps: [...state.steps, step] };
}

/**
 * 吃进一条事件。
 *
 * **换章即重开**：一条流水只讲一章的事。跨章粘在一起的话，「历时 227 秒」
 * 这种数字立刻变成假的，而它看起来和真的一模一样。
 */
export function reduceTranscript(state: TranscriptState, event: TranscriptEvent, now: number): TranscriptState {
  const chapterId = "chapterId" in event ? event.chapterId : undefined;

  // 新一章开始（translating 是唯一的开工信号：它由 orchestrator 的状态机发出）
  if (event.type === "chapter.stateChanged" && event.to === "translating" && chapterId) {
    const fresh: TranscriptState = { chapterId, startedAt: now, steps: [], openThinking: {}, finished: false };
    return push(fresh, { key: "s:translating", kind: "state", title: "开始翻译", detail: chapterId, at: 0 });
  }

  // 还没开工，或者事件属于别的章 → 不收。宁可空着，也不把别处的步骤挂进来。
  if (!state.chapterId) return state;
  if (chapterId && chapterId !== state.chapterId) return state;

  const at = Math.max(0, now - state.startedAt);

  switch (event.type) {
    case "chapter.stateChanged": {
      const to = event.to ?? "";
      const title = STATE_LABELS[to] ?? to;
      const next = push(state, {
        key: `s:${to}:${at}`,
        kind: TERMINAL.has(to) ? (to === "approved" ? "done" : "failed") : "state",
        title,
        ...(event.reason && !event.reason.includes("->") ? { detail: event.reason } : {}),
        at,
      });
      return TERMINAL.has(to) ? { ...next, finished: true } : next;
    }

    case "agent.thinking": {
      const key = `${event.label ?? "?"}#${event.attempt ?? 1}`;
      const open = state.openThinking[key];
      if (!open) {
        // 新思考块开始。若上一块已收尾，中间这段就是模型没在思考、也没在吐正文的时间——
        // 工具通道的第二轮正是在这里起跑。**标成推定，不写成事实**。
        const steps: TranscriptStep[] = [];
        if (state.lastThinkingEndedAt !== undefined) {
          const gapMs = at - state.lastThinkingEndedAt;
          steps.push({
            key: `gap:${at}`,
            kind: "gap",
            title: "工具轮交接",
            detail: `L0 判定回灌给模型 · 间隔 ${gapMs}ms（无专属事件，按两次思考块的间隔推定）`,
            at: state.lastThinkingEndedAt,
          });
        }
        const stepKey = `think:${key}:${at}`;
        steps.push({
          key: stepKey,
          kind: "thinking",
          title: `模型思考（第 ${event.attempt ?? 1} 次尝试）`,
          detail: `档位 ${event.thinking ?? "?"} · 0 字`,
          at,
          running: true,
        });
        return {
          ...state,
          steps: [...state.steps, ...steps],
          openThinking: { ...state.openThinking, [key]: { at, chars: (event.delta ?? "").length, thinking: event.thinking, stepKey } },
        };
      }
      // 累积：只更新那一格，不新增
      const chars = open.chars + (event.delta ?? "").length;
      const thinking = event.thinking ?? open.thinking;
      const steps = state.steps.map((s) => s.key !== open.stepKey ? s : {
        ...s,
        detail: `档位 ${thinking ?? "?"} · ${chars} 字`,
        running: !event.done,
      });
      if (!event.done) {
        return { ...state, steps, openThinking: { ...state.openThinking, [key]: { ...open, chars, thinking } } };
      }
      const rest = { ...state.openThinking };
      delete rest[key];
      const finalSteps = steps.map((s) => s.key !== open.stepKey ? s : {
        ...s,
        detail: `档位 ${thinking ?? "?"} · ${chars} 字 · 历时 ${at - open.at}ms`,
        running: false,
      });
      return { ...state, steps: finalSteps, openThinking: rest, lastThinkingEndedAt: at };
    }

    case "agent.status": {
      // 只收告警。「running/done」这类状态在时间轴上与 chapter.stateChanged 重复，
      // 两条都画等于同一件事说两遍。
      if (event.kind !== "warning" || !event.message) return state;
      return push(state, { key: `warn:${at}`, kind: "warning", title: "告警", detail: event.message, at });
    }

    case "review.progress": {
      if (!event.message) return state;
      return push(state, { key: `rev:${at}`, kind: "review", title: "审校", detail: event.message, at });
    }

    case "translate.progress": {
      // 0% 的「开始翻译」与 chapter.stateChanged 的 translating 是同一件事，不重复画。
      if (!event.message || (event.progress ?? 0) === 0) return state;
      return push(state, { key: `prog:${at}`, kind: "progress", title: "翻译完成", detail: event.message, at });
    }

    default:
      return state;
  }
}

/** 弹窗上那一行「现在在干什么」。取最后一格；没有就是空闲。 */
export function currentActivity(state: TranscriptState): { text: string; running: boolean } | null {
  if (!state.chapterId) return null;
  const last = state.steps[state.steps.length - 1];
  if (!last) return null;
  if (state.finished) return { text: `${state.chapterId} · ${last.title}`, running: false };
  return { text: `${state.chapterId} · ${last.title}`, running: true };
}
