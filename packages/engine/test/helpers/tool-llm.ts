/**
 * 工具通道的假 LLM（KA-5 之后唯一的翻译通道）。
 *
 * **假体必须发运行时真正会发的东西**——这条纪律是学费买来的：
 * KA-4 验收当天三章全 stuck，就是因为假体在工具轮 `return`，而真运行时那时候
 * 是 `throw`；两侧测试各自全绿，接缝全断。所以这里的两轮时序照抄真机：
 *
 *   轮1  只发工具调用，`text` 为空、`stopReason: "toolUse"`、带 `continuation`
 *   轮2  收到 `assistant(continuation)` + `toolResult` 之后才产出 `<paragraph>` 正文
 *
 * 段落 id 只从 **user** 那条消息里取：system 静态前缀含教学样例（p0001/p0002），
 * 把它一并抓进来会造出一个真实模型不会犯的错，然后拿它去指责生产代码。
 */

export interface FakeTerm {
  ja: string;
  zh: string;
  type?: string;
  note?: string | null;
}

interface Message {
  role: string;
  content: string;
  continuation?: unknown;
}

/** 只读 user 消息里的段落 id，按 id 生成译文段落 */
export function paragraphsFrom(messages: Message[], render: (id: string) => string): string {
  const user = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const ids = [...user.matchAll(/<paragraph id="([^"]+)"/g)].map((m) => m[1]!);
  return [...new Set(ids)].map((id) => `<paragraph id="${id}">${render(id)}</paragraph>`).join("\n");
}

export interface ToolLlmOptions {
  /** 轮 1 登记的词。空数组 = 本章没有新词，但仍然调一次工具（哑火判据要求如此） */
  terms?: FakeTerm[];
  /** 语气档案卡（KA-4）。缺省不登记 */
  voices?: Array<Record<string, unknown>>;
  /** 每段译文文本，缺省是一句固定中文 */
  render?: (id: string) => string;
  /** 完全不调工具（本章无新词的另一种合法形态：一轮直接给正文） */
  skipTool?: boolean;
}

/**
 * 造一个走工具通道的假 LLM。
 *
 * 每次 `complete` 独立判断走第几轮：看消息里有没有 `toolResult`——
 * 而不是数调用次数。分批路径下一章会发多次「轮1」，用计数器会在第二批就错位。
 */
export function toolLlm(options: ToolLlmOptions = {}) {
  const render = options.render ?? (() => "爱丽丝笑了。");
  const terms = options.terms ?? [];
  const voices = options.voices ?? [];
  return {
    complete: async (_model: string, messages: Message[]) => {
      const afterTool = messages.some((m) => m.role === "toolResult");
      if (options.skipTool || afterTool) {
        return { text: paragraphsFrom(messages, render), stopReason: "stop" };
      }
      return {
        text: "",
        stopReason: "toolUse",
        continuation: { role: "assistant", content: [{ type: "thinking", thinking: "…", thinkingSignature: "SIG" }] },
        toolCalls: [{
          id: "call_1",
          name: "register_terms",
          arguments: {
            terms: terms.map((t) => ({ type: "person", note: null, ...t })),
            voices,
          },
        }],
      };
    },
  };
}

/** 走工具通道、但工具参数是坏数据（补救层要拦下并说出来） */
export function toolLlmWithRawArgs(args: Record<string, unknown>, render?: (id: string) => string) {
  const paint = render ?? (() => "爱丽丝笑了。");
  return {
    complete: async (_model: string, messages: Message[]) => {
      if (messages.some((m) => m.role === "toolResult")) {
        return { text: paragraphsFrom(messages, paint), stopReason: "stop" };
      }
      return {
        text: "",
        stopReason: "toolUse",
        continuation: { role: "assistant", content: [] },
        toolCalls: [{ id: "call_1", name: "register_terms", arguments: args }],
      };
    },
  };
}
