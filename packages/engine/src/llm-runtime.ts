/**
 * 模型运行时封装 —— 基于 pi-ai 原生 API（createProvider + lazyApi），
 * 不依赖 pi-coding-agent 本体（ADR-0001）。
 *
 * 阶段 0 验证：确认 pi-ai 无头调用 DeepSeek V4-Flash 可用。
 */

import { createProvider, lazyApi } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Context, Model, Tool } from "@earendil-works/pi-ai";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import fs from "node:fs";
import { appendLineWithRotation } from "@lightee/core/rotating-jsonl";
import { retryCall, errorMessageOf, attachErrorKind, isRetryableError, type RetryPolicy, type RetryCallbacks } from "./llm-retry.ts";

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "toolResult";
  content: string;
  /**
   * 续接句柄（KA-1）：**上一轮返回的原始 assistant 消息**，原样放回。
   *
   * 在场时下面的 `toolCalls` / `reasoning` 全部忽略——因为它们是拍扁后的产物，
   * 而拍扁那一步丢掉的东西（`thinkingSignature` 的加密载荷、`toolCall.thoughtSignature`、
   * 块序、`redacted` 标记）恰恰是多轮续接必须的。DeepSeek 思考模式缺推理签名会直接 400。
   *
   * 手工重建的那条路留着：假 LLM、测试、构造历史都要用。**真实多轮永远走这一条。**
   */
  continuation?: unknown;
  /**
   * 本条 assistant 消息发起的工具调用（PT-02）。回灌历史时必须带上——
   * 工具协议要求「调用」与「结果」成对出现，只回结果服务商会拒。
   *
   * 仅在没有 {@link continuation} 时使用。
   */
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  /**
   * 本条 assistant 消息的推理内容，回灌历史时必须原样带回（PT-02 实测）。
   *
   * DeepSeek 在思考模式下会直接拒绝缺它的多轮请求：
   * `The reasoning_text in the thinking mode must be passed back to the API`。
   * 这同时说明推理是**跨轮保留**的——模型第二轮不必把第一轮想过的再想一遍。
   */
  reasoning?: string;
  /** `role: "toolResult"` 专用：这条结果回应哪一次调用 */
  toolCallId?: string;
  toolName?: string;
  /** `role: "toolResult"` 专用：工具执行失败（如校验没通过）时置 true */
  toolIsError?: boolean;
}

/**
 * 把 pi-ai 的 usage 原样接住。**上报什么记什么，没上报的字段缺席**——
 * 补零会让「服务商没说」和「服务商说是 0」在账面上长得一样。
 */
function captureUsage(usage: {
  input: number; output: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number;
  reasoning?: number; totalTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}): LlmUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
    ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.cost === undefined ? {} : { cost: usage.cost }),
  };
}

/**
 * 服务商侧诊断（KA-2），来自 pi-ai 的 `AssistantMessage.diagnostics`。
 *
 * **红线：不收 `details` 与 `stack`。** pi 的 `details` 是 `Record<string, unknown>`，
 * 适配器往里塞什么由适配器决定，可能夹带请求片段（即原文与译文）；`stack` 带本机路径。
 * 这一条会进调用日志与账本，按「只留形状与编号，不留内容」的既有纪律办。
 */
export interface LlmDiagnostic {
  type: string;
  timestamp: number;
  name?: string;
  message?: string;
  code?: string | number;
}

/** 只取安全字段，`details`/`stack` 在这里被丢掉——不是遗漏，是纪律 */
function captureDiagnostics(raw: unknown): LlmDiagnostic[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: LlmDiagnostic[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const entry = item as { type?: unknown; timestamp?: unknown; error?: { name?: unknown; message?: unknown; code?: unknown } };
    const diagnostic: LlmDiagnostic = {
      type: typeof entry.type === "string" ? entry.type : "unknown",
      timestamp: typeof entry.timestamp === "number" ? entry.timestamp : 0,
    };
    if (typeof entry.error?.name === "string") diagnostic.name = entry.error.name;
    if (typeof entry.error?.message === "string") diagnostic.message = entry.error.message;
    if (typeof entry.error?.code === "string" || typeof entry.error?.code === "number") diagnostic.code = entry.error.code;
    out.push(diagnostic);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 响应**形状**分类（KA-1）。与 `llm-retry` 的 {@link LlmErrorKind} 是两条**不同**的轴：
 *
 * - `LlmErrorKind`（transient/quota/auth/…）回答「网络与服务商层面为什么失败」，决定重试策略
 * - `LlmResponseShape` 回答「拿回来的这条消息长什么样」，决定编排层怎么接
 *
 * 此前这条轴的取值是三条**中文字符串**，在 `llm-runtime` 与 `translate-one` 之间当控制流用
 * （`errorMessage === "模型未正常结束"`）。改文案要同时改三处，而没有任何东西会红。
 */
export type LlmResponseShape = "incomplete" | "tool_call_only" | "empty_response";

export interface LlmCallOptions {
  /** thinking level: off | minimal | low | medium | high | xhigh | max */
  thinking?: string;
  maxTokens?: number;
  apiKey?: string;
  baseUrl?: string;
  /**
   * 本次调用的归属标签（`<agent>:<stage>[:<unit>]`，如 `translate:ch012`）。
   *
   * 优先于实例上的 `label`。实例属性是**跨调用共享的可变状态**：并发翻译与提取各阶段
   * 都往同一个字段上写，谁最后写谁赢——这正是 4.87M 事故里全部提取调用都记成
   * `terminologist`、只能靠 prompt 前缀反推阶段的原因。按调用传标签没有这个竞态。
   */
  label?: string;
  /**
   * 本次调用的工作区归属（打进调用日志与历史文件）。
   *
   * 历史文件是全局一份（~/.lightee/llm-history.jsonl），没有这个戳，Agent 控制台
   * 只能把**所有书**的调用混在一张表里（2026-08-14 作者实测：打开演示工作区，
   * 看到的是另一本书的 700 多条记录）。与 `label` 同理按调用传，不放实例属性——
   * 实例是跨调用共享的可变状态，并发时谁最后写谁赢。
   */
  scope?: { workspaceId?: string; chapterId?: string };
  /** 中止信号（流式调用 + 退避等待均可中断） */
  signal?: AbortSignal;
  /** 重试策略（默认照搬 pi: maxRetries=3 · baseDelayMs=2000） */
  retry?: RetryPolicy;
  /** 重试事件回调（用于进度展示/日志） */
  retryCallbacks?: RetryCallbacks;
  /**
   * 思考块增量回调（TR-01）。每个 `thinking_delta` 事件一次，拼起来即完整思考。
   *
   * 此前这些事件只被用来算 TTFT，内容当场丢弃，于是运行中的界面上只有一个转圈的
   * 秒表——模型花两分钟在想什么，人看不到，我也只能事后刨 30MB 历史文件去猜。
   *
   * **回调抛异常不影响调用**：展示层的 bug 不该让翻译失败。
   *
   * 红线：delta 里有原文与译文草稿。可以进 llm-history.jsonl（本就存全文），
   * 可以流给渲染层（进程内），**不得**进 usage.jsonl 与 AppLog。
   */
  onThinking?: (delta: string) => void;
  /**
   * **正文**增量（对应 pi 的 `text_delta`）。
   *
   * 补这个回调的判据是一段实测的黑窗：工具通道的轮 2 全长约 22 秒，其中思考只有
   * 57 个字符、几秒就吐完，**剩下二十来秒是正文在流式产出**——而这段时间界面上
   * 什么都没有。`text_delta` 事件本来就在流里、本来就已经被 `for await` 遍历到，
   * 只是没人接，到达即丢弃。
   *
   * 因此它的代价是**零 API 成本、零额外往返**：同一条流、同一批 token，
   * 只是不再把已经付过钱的产出扔掉。
   *
   * 红线同 {@link onThinking}：delta 里是译文正文，可以流给渲染层（进程内），
   * **不得**进 usage.jsonl 与 AppLog。
   */
  onText?: (delta: string) => void;
  /**
   * 思考**块结束**信号（KA-2，对应 pi 的 `thinking_end` 事件）。
   *
   * 只有 delta 流的话，渲染层分不清「这个思考块结束了」与「还在想、只是暂时没吐字」——
   * 一次调用可能有多个思考块，边界丢了就只能靠超时猜。
   */
  onThinkingEnd?: (blockIndex: number) => void;
  /**
   * 工具调用进度（KA-2，对应 pi 的 `toolcall_start` / `_delta` / `_end`）。
   *
   * 工具轮的全部产出都在参数里，而参数可能是几十条术语。不接这三个事件，
   * 那一段时间界面上是彻底的黑屏。回调抛异常不影响调用（同 {@link onThinking}）。
   */
  onToolCall?: (event: { phase: "start" | "delta" | "end"; index: number; delta?: string; toolCall?: { id: string; name: string; arguments: Record<string, unknown> } }) => void;
  /**
   * 本次调用可用的函数工具（PT-01）。挂在 pi-ai 的 `Context.tools` 上，
   * `streamSimple` 原生支持——此前注释写「一次性对话调用（无工具）」，
   * 是我们没用，不是不能用。不传时行为与从前 byte-identical。
   *
   * 形状约束（KA-2）：`constrainedSampling: { type: "json_schema", strict }` 才让 schema
   * 成为**服务商解码层面**的硬约束。它要求 schema 满足 `additionalProperties: false`
   * 且每个属性都在 `required` 里——可选字段只能写成 `"type": ["string", "null"]`。
   * 是否生效还取决于 provider 的 `supportsStrictMode`（见 {@link ProviderConfig}）。
   */
  tools?: Tool[];
}

/**
 * 单次调用的 token 计量（R0-2）。
 *
 * 语义按 pi-ai 的口径，**`input` 已剔除缓存部分**：openai-completions 与 openai-responses
 * 两条 API 路径都做 `prompt_tokens - cacheRead - cacheWrite`（见 pi-ai
 * `dist/api/openai-completions.js:1075`、`dist/api/openai-responses-shared.js:428`）。
 * 因此提示词总量 = `input + cacheRead + cacheWrite`，命中率的分母只能是这个和，
 * 拿 `input` 当「全部输入」算会把命中率算高。
 */
export interface LlmUsage {
  /** 未命中缓存的输入 token（不含 cacheRead / cacheWrite） */
  input: number;
  output: number;
  /** 命中缓存被读出的输入 token */
  cacheRead?: number;
  /** 写入缓存的输入 token（DeepSeek 不单独上报，恒为 0；Anthropic 系会给） */
  cacheWrite?: number;
  /** `cacheWrite` 中按 1 小时留存写入的部分（只有 Anthropic 拆这一档）。是子集，不另加 */
  cacheWrite1h?: number;
  /**
   * 服务商上报的**推理 token 数**（`output_tokens_details.reasoning_tokens`）。
   * 它是 `output` 的子集，不是另加的一笔。
   *
   * 此前整条链都没接这个字段，于是「推理花了多少」只能按字符估
   * （还为此标定过 2.26 字符/token）。上报值在的时候就该用上报值——
   * 估算是拿不到真值时的退路，不是默认做法。
   *
   * **服务商没上报时缺席，不补零**：0 与「没说」是两件事。
   */
  reasoning?: number;
  /** 输入 + 输出的总量（服务商口径） */
  totalTokens?: number;
  /**
   * pi 按模型价目算好的成本。自己再乘一遍只会算错——价目表在 pi 那边，
   * 我们这边没有第二份真相。
   */
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

/** LLM 调用日志（Agent 控制台 debug 用：完整 prompt + response，环形缓冲 + 历史文件持久化） */
export interface LlmCallLogEntry {
  id: string;
  /** agent 归属（orchestrator/terminologist/translator/reviewer/test/detect 等） */
  label?: string;
  /** 工作区归属（LlmCallOptions.scope 打的戳）。缺席 = 打戳之前的旧记录，无法归属到某本书 */
  workspaceId?: string;
  /** 章节归属（同上） */
  chapterId?: string;
  model: string;
  thinking?: string;
  ok: boolean;
  /** 完整 prompt（system + user 拼接文本） */
  prompt: string;
  /** 原始发送消息（system/user 分离，完整结构） */
  messages?: Array<{ role: string; content: string }>;
  /**
   * 本次**发出去**的工具定义（名称 + description + JSON Schema）。
   *
   * KA-5 之后术语登记的格式说明书**不在 prompt 里**——判据在 `description`、形状由
   * schema 保证。只记 messages 的话，导出里就完全看不到这套指令，读的人会以为
   * 我们什么都没告诉模型。发出去的东西记了一半，等于没记。
   *
   * 与 {@link toolCalls}（模型**回来**的工具调用）成对：一个是问，一个是答。
   */
  tools?: Array<{ name: string; description?: string; parameters?: unknown }>;
  /** 完整响应 */
  response: string;
  /**
   * 本次尝试发起的工具调用（参数完整落盘）。
   *
   * 补这个字段的判据是一次真实的空白：工具通道的**轮 1 只发工具调用、没有正文**，
   * 于是历史里 `response` 长度 0——2026-08-12 单章实测那 262 秒、12270 推理 token
   * 的产出，在原始记录里是一片空白，只能靠 toolResult 反推它登记了什么。
   *
   * 而「禁止用推断代替原始数据」正是本仓库的标准指令。一轮调用最贵的产出
   * 恰好是唯一没记的那一半，与 TR-02 修过的「失败尝试不留思考」是同一个病。
   */
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  /** thinking 块（reasoning 完整内容，供审核） */
  reasoning?: string;
  /** 首个内容 token 到达耗时（ms，相对本次尝试开始） */
  ttftMs?: number;
  ms: number;
  ts: number;
  error?: string;
  /**
   * 本次**逻辑调用**累计消耗的网络尝试次数（含瞬态重试与 thinking 降档重试）。
   *
   * 不记这个数，「一次就成」与「退避三次才成」在账面上完全一样（EX-01 / 法证 C5）。
   */
  attempts?: number;
  /**
   * 本条是这次逻辑调用的**第几次网络尝试**（1 起）。
   *
   * TR-02 之前一次逻辑调用只落一条日志（终局那一次），降档途中废掉的尝试
   * 思考内容一个字都不留——全库 596 条历史里「失败且带思考内容」的条目是 **0**。
   * 于是 2026-08-12 诊断那四次失败时，手上只有一条侥幸成功的旁证。
   * 出问题的时候恰恰是最需要溯源的时候，而那正是唯一没记的一半。
   */
  attempt?: number;
  /**
   * 本次调用的 token 计量（服务商未上报时缺席）。
   * 逐条记录而不是只记总量：总量回答「这一轮花了多少」，只有逐条能回答
   * 「哪一次调用把前缀打穿了」——后者才是缓存调优要看的东西。
   */
  usage?: LlmUsage;
  /** 服务商原始停止状态（未经映射）。见 {@link LlmCallResult.rawStopReason} */
  rawStopReason?: string;
  /**
   * 服务商侧诊断（KA-2，已剔除 details 与 stack）。
   *
   * 落在这里而不是别处：这份历史正是「那两分钟发生了什么」的翻查地。
   * 2026-08-12 我花大半天用 `output ≈ maxTokens` 反推截断原因、又花一轮排查
   * PT-02 的 400——服务商自己的诊断很可能一直就在这个数组里，只是我们整个丢掉了。
   */
  diagnostics?: LlmDiagnostic[];
}

/**
 * 一次**没能交付结果、但已经付过钱**的网络尝试。
 *
 * EX-01 定的是「一次逻辑调用一行、重试在内部消化」，只留一个 attempts 计数。
 * 真实跑批（2026-08-12）证明这在 thinking 高档下会把账本变成假账：思考吃光输出预算、
 * 不吐文本的那几次尝试，每次都是完整的一笔 output 花费（实测单次 8190 token、
 * 真正文本 174 字符），而账面上只留下成功那一次的数字。
 *
 * 所以废掉的尝试要各自带 usage 报出来，由记账层落成独立的行。
 */
export interface WastedAttempt {
  /** 这次尝试用的思考档位 */
  thinking?: string;
  ms: number;
  /**
   * `incomplete`（服务商报 status=incomplete 且无正文——**原因未知**，pi-ai 把所有
   * incomplete 都映射成 stopReason="length"，不读 incomplete_details）/
   * `empty_response`（正常结束但没有正文）/ `transient`（可重试）/ `other`。
   *
   * 注意 `incomplete` **不等于**「输出预算不够」。想知道真实原因必须看服务商
   * 原始响应——这正是 trace 要补的窟窿。在拿到证据之前不要给它安一个具体病因。
   */
  errorKind: "incomplete" | "empty_response" | "tool_call_only" | "transient" | "other";
  /**
   * 响应形状（KA-1）。`errorKind` 是形状轴与重试轴的并集（历史形态，账本已在读），
   * 这一栏是**形状轴的原值**：在场时 `errorKind` 就等于它，缺席说明这次是网络/瞬态失败。
   *
   * 它的存在是为了让分类不再依赖比较中文文案——文案换个词不该改变任何判断。
   */
  shapeKind?: LlmResponseShape;
  /** 服务商给的用量。流式错误可能拿不到，此时为 undefined——不猜 */
  usage?: LlmUsage;
  /** 服务商侧诊断（KA-2）。「为什么废的」的答案可能一直就在这里，我们此前整个丢掉 */
  diagnostics?: LlmDiagnostic[];
  /** 推理**字符数**（不是内容）。与 textChars 一起判「预算花到哪去了」 */
  reasoningChars?: number;
  /** 正文**字符数**（不是内容）。空响应时为 0，正是这一栏让「空」变得可证 */
  textChars?: number;
  stopReason?: string;
  /**
   * 服务商原始状态，未经 pi-ai 归一映射。废掉的尝试是唯一需要问「为什么废的」
   * 的地方——`stopReason` 把所有 incomplete 压成 length，只有这一栏答得上来。
   */
  rawStopReason?: string;
  /**
   * 本次尝试**发出去的**输出预算（未配置时 undefined，不编默认值）。
   *
   * 少了这一栏，`output=16382` 只是个孤立数字；有了它才知道那是**触顶**。
   * 2026-08-12 第二次跑批：四次失败的 output 是 16382/16382/16383/16385，
   * 配置里的 maxTokens 正是 16384——碰上限的全失败、低于上限的全成功。
   * 当时账本没有这一栏，报告只能写「被服务商截断」，把我们自己设的天花板
   * 栽给了服务商。归因错了，下一步动作就会错。
   */
  maxTokens?: number;
}

export interface LlmCallResult {
  /**
   * 服务商返回的**原始 assistant 消息**（KA-1）。这是本结构的真相来源，
   * 下面的 `text` / `reasoning` / `toolCalls` 全是它的派生便利值。
   *
   * 为什么必须留着整条：两次 `join` 会丢掉 `ThinkingContent.thinkingSignature`
   * （Responses API 推理项的 id 与加密载荷）、`ToolCall.thoughtSignature`、
   * `redacted` 标记与块序。前两样是多轮续接的硬前提——PT-02 的 400 就是这么来的。
   *
   * 回灌时原样塞进 {@link LlmMessage.continuation}，中间不拆开。
   * 类型是 `AssistantMessage`（engine 本就依赖 pi-ai）；桥层按 `unknown` 搬运，
   * 那一侧不需要、也不应该认识 pi 的类型。
   */
  continuation?: AssistantMessage;
  text: string;
  /**
   * 人可读的思考内容。**不含被安全过滤器删除的块**——那些块的 `thinking` 是空的，
   * 真正的载荷在 `thinkingSignature` 里且不可读。把它们 join 进来只会让
   * 「被删除」和「真的什么都没想」在界面上长得一样，见 {@link reasoningRedacted}。
   */
  reasoning?: string;
  /** 被服务商安全过滤器删除的思考块**数量**（0 时缺席）。内容在 continuation 里，不在这儿 */
  reasoningRedacted?: number;
  /** 服务商侧诊断（KA-2，已剔除 details 与 stack）。见 {@link LlmDiagnostic} */
  diagnostics?: LlmDiagnostic[];
  /** 首个内容 token 到达耗时（ms） */
  ttftMs?: number;
  usage?: LlmUsage;
  stopReason?: string;
  /**
   * 服务商给的**原始**状态，未经 pi-ai 的归一映射。
   *
   * `stopReason` 把所有 `status:"incomplete"` 一律压成 `"length"`
   * （openai-responses-shared.js:634），据此断言病因就是编造。而未经映射的
   * 原始值一直存在这里（同文件 446/616 写入；completions 适配器 327 行同理）——
   * 2026-08-12 我花了大半天用 output≈maxTokens 反推真实原因，**而这个字段
   * 从头到尾就在那儿，只是没人读**。
   */
  rawStopReason?: string;
  /** 服务商侧的响应标识。跨系统追一次调用时，这是天然的锚点 */
  responseId?: string;
  /** 实际服务这次请求的模型（可能带日期后缀，与请求的 model 未必一字不差） */
  responseModel?: string;
  /** 本次逻辑调用消耗的网络尝试次数（1 = 一次就成）。见 {@link LlmCallLogEntry.attempts} */
  attempts?: number;
  /**
   * 真正拿到文本的那一档。与调用方请求的档位不同即说明发生了降档。
   * 缺了这一栏，账本上「用户选了 max」和「降到 low 才成」长得一模一样——
   * 2026-08-12 的诊断就卡在这里：账本记 max，历史日志记 low，两份记录自相矛盾。
   */
  thinking?: string;
  /** 成功之前废掉的尝试（一次就成时为空数组）。见 {@link WastedAttempt} */
  wasted?: WastedAttempt[];
  /** 本次调用发出去的输出预算（未配置时 undefined）。见 {@link WastedAttempt.maxTokens} */
  maxTokens?: number;
  /**
   * 模型发起的工具调用（PT-01）。参数已过服务商侧 schema 校验（strict 模式下），
   * 但**真伪校验仍在 L0**：schema 管形状，不管「这个词是否真的在原文里」。
   */
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}

/** models.json 的自定义 provider 配置形态（与 pi 兼容） */
export interface ProviderConfig {
  name?: string;
  baseUrl?: string;
  api?: "openai-responses" | "openai-completions";
  apiKey?: string;
  apiKeyEnv?: string;
  /** auth.json 中的键名（默认=provider id） */
  authKey?: string;
  authHeader?: string;
  models?: Array<{
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    thinkingLevelMap?: Record<string, string | null>;
    supportsStrictMode?: boolean;
  }>;
}

/**
 * auth.json 条目的机密解封（RH-17）。宿主（Electron 主进程）注入 `decryptSecret` 后，
 * 带 `sealed` 标记的条目才可用；未注入或解密失败 → 视为无密钥（返回 undefined），
 * **绝不把密文当密钥用**——那会以「服务商返回 401」的形式误导用户。
 */
function entrySecret(entry: unknown, decryptSecret?: (sealed: string) => string): string | undefined {
  if (typeof entry === "string") return entry || undefined;
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as { type?: string; key?: string; sealed?: string };
  if (!record.key) return undefined;
  if (record.sealed === undefined) return record.key;
  if (!decryptSecret) return undefined;
  try {
    return decryptSecret(record.key) || undefined;
  } catch {
    return undefined;
  }
}

function resolveApiKey(config: ProviderConfig, configDir: string | undefined, decryptSecret?: (sealed: string) => string): string | undefined {
  if (config.apiKey) return config.apiKey;
  if (config.apiKeyEnv) return process.env[config.apiKeyEnv];
  if (!configDir) return undefined;
  // 从配置目录 auth.json 读取（目录由宿主显式传入，见 LlmRuntimeOptions.configDir）
  const authPath = path.join(configDir, "auth.json");
  try {
    if (fs.existsSync(authPath)) {
      const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      const entry = auth[configKeyForAuth(config)] ?? auth[config.name ?? ""];
      // oauth 登录得到的 token 同样作为 Bearer key 使用，与 api_key 条目一视同仁。
      return entrySecret(entry, decryptSecret);
    }
  } catch {
    // 忽略 auth.json 读取错误
  }
  return undefined;
}

/** auth.json 的键通常是 provider id 或 provider name */
function configKeyForAuth(config: ProviderConfig): string {
  return config.authKey ?? "";
}

/**
 * 配置目录：只认宿主显式传入的 `configDir`，其次 `LIGHTEE_CONFIG_DIR`（隔离验收与测试），
 * 都没有就是**没有配置目录**——不猜、不回退。
 *
 * 这里从前会在 `~/.lightee/models.json` 不存在时回退到 `~/.pi/agent`：那是早期与另一个
 * agent 工具共用配置留下的分支。写入侧早就独立了，读取侧没跟着拆。对一个已发布的应用，
 * 这个回退有三重毛病——它去读**另一个工具的 API Key**；行为取决于那个不相干的工具装没装；
 * 而且全程静默，用户根本不知道密钥是从哪儿来的。路径与凭据都属于宿主的政策，库不该自作主张。
 */
function defaultConfigDir(): string | undefined {
  const override = process.env.LIGHTEE_CONFIG_DIR?.trim();
  return override ? override : undefined;
}

/** 从配置目录 models.json 读取 provider 配置 */
function loadProviders(configDir: string | undefined): Record<string, ProviderConfig> {
  if (!configDir) return {};
  const p = path.join(configDir, "models.json");
  if (!fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    return (raw.providers ?? {}) as Record<string, ProviderConfig>;
  } catch {
    return {};
  }
}

export interface LlmRuntimeOptions {
  providers?: Record<string, ProviderConfig>;
  /** 配置目录（models.json + auth.json）。不传则退到 `LIGHTEE_CONFIG_DIR`，再没有就没有磁盘配置。 */
  configDir?: string;
  /** LLM 调用历史持久化文件（JSONL 追加）。不传 = 不落盘；传 false 亦然。 */
  historyFile?: string | false;
  /**
   * auth.json 中带 `sealed` 标记的机密的解密函数（RH-17）。由宿主注入
   * （Electron 主进程 = safeStorage/DPAPI）。不注入 → 加密条目视为无密钥。
   */
  decryptSecret?: (sealed: string) => string;
}

/** 单次逻辑调用的网络尝试总预算（降档梯子 × 每档重试的乘积上限） */
const MAX_TOTAL_ATTEMPTS = 8;

/** 思考档位由低到高 */
const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_ORDER)[number];

/**
 * 空响应降档的记忆：模型 → 上一次真正吐出文本的档位。
 *
 * 真实 46 章跑批（2026-08-12）实测：thinking=max 下每一章都要重走
 * max→xhigh→high→medium→low，前四档注定无文本输出，每一档还烧掉一整个输出预算
 * （单次 output 8190 token、真正文本 174 字符）。同一个模型在同一档位已经证明过
 * 「思考把预算吃光」，不该每次调用都重新证明一遍——46 章就是 184 次注定失败的调用。
 *
 * 两条边界：
 * - 只用来**降**起点，绝不抬高。用户把档位调低是明确的选择，记忆无权推翻。
 * - 进程级、不落盘。它是本次运行对这个模型的观察，换模型版本或换台机器都该重新学。
 */
const workingThinking = new Map<string, ThinkingLevel>();

/** 预算耗尽的终止错误：带独立标记，避免文案里的「空响应」把它再送回降档分支 */
function emptyDowngradeExhausted(attempts: number, tried: string[]): Error {
  const error = new Error(
    `空响应降档已达上限（${attempts} 次尝试，已试档位: ${tried.join(" → ")}）——模型持续无文本输出，请更换模型或降低输入长度后重试`
  ) as Error & { errorMessage?: string; emptyDowngradeExhausted?: boolean };
  error.errorMessage = "空响应降档已达上限";
  error.emptyDowngradeExhausted = true;
  return error;
}

export class LlmRuntime {
  private providers: Map<string, ReturnType<typeof createProvider>> = new Map();
  /** 注册时的 provider 配置（含 authKey），密钥解析的唯一依据 */
  private configs: Map<string, ProviderConfig> = new Map();
  private models: Map<string, Model<Api>> = new Map(); // "provider/modelId" -> Model
  private readonly configDir: string | undefined;
  /** LLM 调用历史持久化文件（JSONL） */
  private readonly historyFile?: string;
  /** 当前调用归属标签（调用方在调用前设置） */
  label?: string;
  private callLog: LlmCallLogEntry[] = [];
  private callLogMax = 50;
  private callSeq = 0;
  /** token 累计（侧栏真实用量展示；四个字段互不重叠，可直接相加得提示词总量） */
  private tokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  getTokenTotals(): { input: number; output: number; cacheRead: number; cacheWrite: number } {
    return { ...this.tokenTotals };
  }
  /** 逐**尝试**累计，成功失败一视同仁——废掉的尝试每一笔都是真花费（TR-12） */
  private addTokenTotals(usage?: LlmUsage): void {
    if (!usage) return;
    this.tokenTotals.input += usage.input ?? 0;
    this.tokenTotals.output += usage.output ?? 0;
    this.tokenTotals.cacheRead += usage.cacheRead ?? 0;
    this.tokenTotals.cacheWrite += usage.cacheWrite ?? 0;
  }

  /** 最近 N 次 LLM 调用（新→旧） */
  getCallLog(limit = 30): LlmCallLogEntry[] {
    return this.callLog.slice(-limit).reverse();
  }
  getCallLogById(id: string): LlmCallLogEntry | undefined {
    return this.callLog.find((entry) => entry.id === id);
  }
  clearCallLog(): void {
    this.callLog = [];
  }
  private pushCallLog(entry: Omit<LlmCallLogEntry, "id" | "ts">): void {
    const full: LlmCallLogEntry = { ...entry, id: `llm-${++this.callSeq}-${Date.now().toString(36)}`, ts: Date.now() };
    this.callLog.push(full);
    if (this.callLog.length > this.callLogMax) this.callLog.splice(0, this.callLog.length - this.callLogMax);
    // 历史持久化（JSONL 同步追加——LLM 调用频率低，避免异步竞态丢记录；失败静默）。
    // 走 appendLineWithRotation 而不是裸 appendFileSync：这个文件存的是完整 prompt 与
    // 响应，实测每次调用约 62KB，一本 300 章的书就要几十 MB，而它此前只增不减。
    // 轮转后规范路径始终是最新的那份，getHistory 的尾窗读取因此不受影响。
    if (this.historyFile) {
      appendLineWithRotation(this.historyFile, JSON.stringify(full) + "\n");
    }
  }

  /**
   * 历史行里的 usage 归一化（R0-2）。
   *
   * 历史文件是**追加式跨版本**的：R0-2 之前写下的行根本没有 usage 键，手改过的行还可能
   * 把它写成字符串。消费方（成本分析、控制台）拿到的必须要么是合法四字段、要么是
   * undefined——绝不能是「看着像 usage 的脏值」，那会静默算出错误的命中率。
   */
  private static normalizeUsage(raw: unknown): LlmUsage | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const record = raw as Record<string, unknown>;
    const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
    const input = num(record.input);
    const output = num(record.output);
    if (input === undefined || output === undefined) return undefined;
    const usage: LlmUsage = { input, output, cacheRead: num(record.cacheRead), cacheWrite: num(record.cacheWrite) };
    // TR-11 之后写下的行还带推理 token 数与成本。回读不能把它们洗掉——
    // 写盘时有、读回来没有，等于这些字段只存在于没人看的时刻。
    const cacheWrite1h = num(record.cacheWrite1h);
    if (cacheWrite1h !== undefined) usage.cacheWrite1h = cacheWrite1h;
    const reasoning = num(record.reasoning);
    if (reasoning !== undefined) usage.reasoning = reasoning;
    const totalTokens = num(record.totalTokens);
    if (totalTokens !== undefined) usage.totalTokens = totalTokens;
    if (record.cost && typeof record.cost === "object") {
      const cost = record.cost as Record<string, unknown>;
      const parts = { input: num(cost.input), output: num(cost.output), cacheRead: num(cost.cacheRead), cacheWrite: num(cost.cacheWrite), total: num(cost.total) };
      // 五个数字缺一个都不收：半份成本比没有成本更糟——它会被当成全额去加总
      if (Object.values(parts).every((value) => value !== undefined)) usage.cost = parts as NonNullable<LlmUsage["cost"]>;
    }
    return usage;
  }

  /**
   * 历史解析缓存。控制台在跑批期间随事件反复刷新，而按书过滤后每次都要 2000 条窗口；
   * 从前每次刷新都全量读 40+ MB 文件并把**每一行**（含完整 prompt）JSON.parse 一遍，
   * 只为切出尾部——主进程 CPU/GC 被反复打满。文件没变（size+mtime 同）就直接回缓存；
   * 一次 LLM 调用期间文件不追加，思考流触发的整串刷新因此一次都不用碰盘。
   * 内存代价 = 缓存的尾窗（≤ 上次请求的 limit 条），随历史文件轮转议题一并再收。
   */
  private historyCache?: { size: number; mtimeMs: number; limit: number; entries: LlmCallLogEntry[] };

  /** 读取跨运行完整调用历史（新→旧；从持久化文件，含所有已运行会话） */
  async getHistory(limit = 500): Promise<LlmCallLogEntry[]> {
    if (!this.historyFile) return [];
    try {
      const meta = await stat(this.historyFile);
      const cache = this.historyCache;
      if (cache && cache.size === meta.size && cache.mtimeMs === meta.mtimeMs && cache.limit >= limit) {
        return cache.entries.slice(0, limit);
      }
      const text = await readFile(this.historyFile, "utf-8");
      // 只解析请求的尾窗：全量 parse 几百条带全文的记录、再丢掉大半，是纯浪费。
      // 代价：尾窗里混着损坏行时返回条数会略少于 limit（从前是先全解析再切，条数精确）——
      // 损坏行本就是异常态，为它给每次刷新加一整份全量解析不值。
      const lines = text.split("\n").filter(Boolean).slice(-limit);
      const out: LlmCallLogEntry[] = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as LlmCallLogEntry;
          const usage = LlmRuntime.normalizeUsage((entry as { usage?: unknown }).usage);
          if (usage) entry.usage = usage;
          else delete entry.usage;
          out.push(entry);
        } catch { /* 跳过损坏行 */ }
      }
      const entries = out.reverse();
      this.historyCache = { size: meta.size, mtimeMs: meta.mtimeMs, limit, entries };
      return entries.slice(0, limit);
    } catch {
      return [];
    }
  }
  private buildPromptText(messages: LlmMessage[]): string {
    return messages.map((m) => `${m.role === "system" ? "[系统]" : m.role === "assistant" ? "[助手]" : "[用户]"} ${m.content}`).join("\n\n");
  }

  private readonly decryptSecret?: (sealed: string) => string;

  /** models.json 是否是本运行时的真相来源（create({ providers }) 传了内存配置时为 false） */
  private readonly diskBacked: boolean;
  /** 上次载入时 models.json 的可见状态指纹，用于探测运行期间的外部修改 */
  private diskStamp = "";

  private constructor(configDir: string | undefined, historyFile: string | false | undefined, decryptSecret: ((sealed: string) => string) | undefined, diskBacked: boolean) {
    this.configDir = configDir;
    // 不传就不落盘。从前这里默认写 `~/.lightee/llm-history.jsonl`——库替宿主选了个
    // 主目录位置，于是任何 import engine 的进程（含脚本与测试）都会往那儿追加。
    this.historyFile = historyFile === false ? undefined : historyFile;
    this.decryptSecret = decryptSecret;
    this.diskBacked = diskBacked;
  }

  /**
   * 清空空响应降档的档位记忆（见 {@link workingThinking}）。
   * 记忆是进程级的，用例之间会串味——只给测试用。
   */
  static resetThinkingMemory(): void {
    workingThinking.clear();
  }

  /** 创建运行时；支持 LlmRuntime.create() / create(providers) / create({ configDir, providers }) */
  static create(options?: LlmRuntimeOptions | Record<string, ProviderConfig>): LlmRuntime {
    const opts: LlmRuntimeOptions = options !== undefined && typeof options === "object" && !Array.isArray(options) && ("providers" in options || "configDir" in options || "historyFile" in options || "decryptSecret" in options)
      ? options as LlmRuntimeOptions
      : { providers: options as Record<string, ProviderConfig> | undefined };
    const dir = opts.configDir ?? defaultConfigDir();
    const runtime = new LlmRuntime(dir, opts.historyFile, opts.decryptSecret, opts.providers === undefined);
    if (opts.providers) {
      for (const [id, cfg] of Object.entries(opts.providers)) runtime.registerProvider(id, cfg);
    } else {
      runtime.loadFromDisk();
    }
    return runtime;
  }

  /** models.json 的可见状态指纹（mtime:size）；读不到时为空串 */
  private diskStampNow(): string {
    if (!this.configDir) return "";
    try {
      const stat = fs.statSync(path.join(this.configDir, "models.json"));
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "";
    }
  }

  /** 按 models.json 整体重建注册表——增、删、改都要反映，所以是替换而不是叠加 */
  private loadFromDisk(): void {
    this.diskStamp = this.diskStampNow();
    this.providers.clear();
    this.models.clear();
    this.configs.clear();
    for (const [id, cfg] of Object.entries(loadProviders(this.configDir))) this.registerProvider(id, cfg);
  }

  registerProvider(id: string, cfg: ProviderConfig): void {
    // 密钥在**每次调用时**解析，不在注册时快照：
    //  1) 用户在设置面板保存密钥后无需重启即可生效；
    //  2) 解密依赖宿主的加密后端，而它在进程启动早期尚不可用（Electron app ready 之前）。
    const authConfig = { ...cfg, authKey: cfg.authKey ?? id };
    // 注册时那份 config 就是解析密钥的唯一依据（见 resolveKey）：内存 providers 不在磁盘上。
    this.configs.set(id, authConfig);
    const provider = createProvider({
      id,
      name: cfg.name ?? id,
      baseUrl: cfg.baseUrl,
      auth: { apiKey: { name: `${id} api key`, resolve: async () => {
        const apiKey = resolveApiKey(authConfig, this.configDir, this.decryptSecret);
        return apiKey ? { type: "api_key" as const, key: apiKey, providerId: id } as never : undefined;
      } } },
      models: (cfg.models ?? []).map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        api: (cfg.api ?? "openai-completions") as Api,
        provider: id as never,
        baseUrl: cfg.baseUrl ?? "",
        reasoning: true,
        input: ["text"] as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: m.contextWindow ?? 128_000,
        maxTokens: m.maxTokens ?? 8192,
        thinkingLevelMap: m.thinkingLevelMap,
        // strict 工具开关（KA-2）：`ProviderConfig.models[].supportsStrictMode` 此前
        // 声明了却从未传下去，等于把一个明确的失败推迟到运行时——pi 的规则是
        // 不支持时 `strict:"require"` 直接抛错、`"prefer"` 静默降级为普通函数工具。
        // 没配就**缺席**，让 pi 用它自己那套按 API 区分的默认值，不在这里编一个。
        ...(m.supportsStrictMode === undefined ? {} : { compat: { supportsStrictMode: m.supportsStrictMode } }),
      })),
      api: lazyApi(async () => {
        if (cfg.api === "openai-responses") {
          const mod = await import("@earendil-works/pi-ai/api/openai-responses");
          return mod as never;
        }
        const mod = await import("@earendil-works/pi-ai/api/openai-completions");
        return mod as never;
      }),
    });
    this.providers.set(id, provider);
    for (const m of (cfg.models ?? [])) {
      const key = `${id}/${m.id}`;
      this.models.set(key, provider.getModels().find((x) => x.id === m.id)!);
    }
  }

  /**
   * 解析某模型对应服务商的 API Key（`complete()` 唯一的取密钥入口）。
   *
   * 曾经这里是一个模块级函数，三个来源全取错，任一都会让「填了 Key 仍报没有 Key」：
   *  1) 不传 `decryptSecret` —— RH-17 用 DPAPI 封存机密后，所有 `sealed` 条目一律解析成
   *     undefined，真实 LLM 全链路（翻译/审校/术语/测试连接）从加密上线那天起就是断的；
   *  2) 用 `defaultConfigDir()` 而非 `this.configDir` —— 无视 `create({ configDir })`；
   *  3) 重新 `loadProviders()` 读磁盘 —— `create({ providers })` 的内存配置不参与解析。
   *
   * 注册时的 config + 实例的 configDir + 实例的 decryptSecret 才是完整依据，缺一不可。
   */
  private resolveKey(modelRef: string): string | undefined {
    const cfg = this.configs.get(modelRef.split("/")[0] ?? "");
    return cfg ? resolveApiKey(cfg, this.configDir, this.decryptSecret) : undefined;
  }

  /** 可用模型列表 */
  listModels(): string[] {
    return [...this.models.keys()];
  }

  /** 解析 "provider/model" */
  getModel(ref: string): Model<Api> | undefined {
    // 磁盘上的 models.json 变了就重建注册表：设置面板增删模型、或按 UI 提示手改文件之后，
    // 不该要求用户重启应用——提示原文就是「保存后点『测试连接』生效」。
    // 读不到文件时保留既有快照：一次瞬时读失败不该让所有模型凭空消失。
    if (this.diskBacked) {
      const stamp = this.diskStampNow();
      if (stamp !== "" && stamp !== this.diskStamp) this.loadFromDisk();
    }
    return this.models.get(ref);
  }

  /**
   * 一次性对话调用（无工具）。
   */
  async complete(
    modelRef: string,
    messages: LlmMessage[],
    options: LlmCallOptions = {}
  ): Promise<LlmCallResult> {
    const model = this.getModel(modelRef);
    if (!model) {
      throw new Error(`模型不存在: ${modelRef}（可用: ${this.listModels().join(", ")}）`);
    }
    const provider = this.providers.get(modelRef.split("/")[0]!);
    if (!provider) {
      throw new Error(`provider 不存在: ${modelRef}`);
    }

    const systemPrompt = messages.find((m) => m.role === "system")?.content;
    const nonSystem = messages.filter((m) => m.role !== "system");

    const context: Context = {
      systemPrompt,
      // 三种消息形态（PT-02）。此前只有 user/assistant 两种、content 恒为字符串——
      // 工具协议要求 assistant 轮带着自己发起的调用、结果轮带着 toolCallId 与之配对，
      // 缺任何一半服务商都会拒绝这段历史。
      messages: nonSystem.map((m) => {
        // 续接句柄优先（KA-1）：上一轮的原始消息原样放回，一个字节都不重建。
        // 拆开再拼回来就是丢签名的那一步——多轮的失败正是从那里开始的。
        if (m.continuation) return m.continuation;
        if (m.role === "toolResult") {
          return {
            role: "toolResult" as const,
            toolCallId: m.toolCallId ?? "",
            toolName: m.toolName ?? "",
            content: [{ type: "text", text: m.content }],
            isError: m.toolIsError === true,
            timestamp: Date.now(),
          };
        }
        if (m.role === "assistant") {
          return {
            role: "assistant" as const,
            // 推理块排在最前：DeepSeek 思考模式下缺它会直接 400（PT-02 实测）
            content: [
              ...(m.reasoning ? [{ type: "thinking", thinking: m.reasoning }] : []),
              ...(m.content ? [{ type: "text", text: m.content }] : []),
              ...(m.toolCalls ?? []).map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments })),
            ],
          };
        }
        return { role: "user" as const, content: m.content };
      }) as never,
      // 工具挂在 Context 上（pi-ai 类型即如此），不是流选项——不传时字段缺席
      ...(options.tools ? { tools: options.tools } : {}),
    };

    // 一次流式调用（重试的 produce 单元）；thinking 可降级重试
    let thinking = options.thinking;
    // 起点按记忆下调：这个模型上一次在哪一档真正吐出过文本，就从那一档开始。
    // 只降不升——用户调低档位是明确的选择。
    const remembered = workingThinking.get(modelRef);
    if (remembered && thinking) {
      const wanted = THINKING_ORDER.indexOf(thinking as ThinkingLevel);
      const known = THINKING_ORDER.indexOf(remembered);
      if (wanted > known && known >= 0) thinking = remembered;
    }
    // 降档梯子（最多 7 档）与每档重试预算（默认 4 次）相乘可达 28 次网络调用；
    // 总预算在 produce 入口硬性封顶，超限即失败——一次逻辑调用不该无限烧下去。
    let attempts = 0;
    const triedThinking: string[] = [];
    const wasted: WastedAttempt[] = [];
    // 按调用传的标签优先于实例属性——实例属性是跨调用共享的可变状态（见 LlmCallOptions.label）
    const label = options.label ?? this.label;
    const produce = async (): Promise<LlmCallResult> => {
      if (attempts >= MAX_TOTAL_ATTEMPTS) throw emptyDowngradeExhausted(attempts, triedThinking);
      attempts += 1;
      const level = thinking ?? "(默认)";
      if (triedThinking[triedThinking.length - 1] !== level) triedThinking.push(level);
      const attemptThinking = thinking;
      const attemptStarted = Date.now();
      const attemptNo = attempts;
      try {
        const settled = await runAttempt();
        // 侧栏累计**逐尝试**加（TR-12）：只加成功那次会让废掉的尝试在侧栏上一个
        // token 都看不见，而它们每一笔都是真花费——账本记对了、侧栏低报，两边对不上。
        this.addTokenTotals(settled.usage);
        // 逐尝试落盘（TR-02）：成功那一次也按尝试记，与失败的几次同一格式，
        // 排在一起就是这次逻辑调用的完整经过。
        this.pushCallLog({
          label,
          ...(options.scope?.workspaceId ? { workspaceId: options.scope.workspaceId } : {}),
          ...(options.scope?.chapterId ? { chapterId: options.scope.chapterId } : {}),
          model: modelRef,
          thinking: attemptThinking,
          ok: true,
          prompt: this.buildPromptText(messages),
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          // 发出去的工具定义（KA-5 之后术语登记的指令只存在于这里，prompt 里一个字都没有）
          ...(options.tools?.length ? { tools: options.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) } : {}),
          response: settled.text,
          // 工具轮的产出全在这里：`text` 为空不代表这一轮什么都没产出
          ...(settled.toolCalls?.length ? { toolCalls: settled.toolCalls } : {}),
          reasoning: settled.reasoning,
          ttftMs: settled.ttftMs,
          ms: Date.now() - attemptStarted,
          usage: settled.usage,
          ...(settled.rawStopReason ? { rawStopReason: settled.rawStopReason } : {}),
          ...(settled.diagnostics ? { diagnostics: settled.diagnostics } : {}),
          attempt: attemptNo,
          attempts: attemptNo,
        });
        return settled;
      } catch (cause) {
        const failure = cause as {
          reasoning?: string; usage?: LlmUsage; rawStopReason?: string; diagnostics?: LlmDiagnostic[];
          /** `tool_call_only` 形态的错误带着工具调用——失败的那一次同样要留原始产出 */
          toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
        } | null;
        this.addTokenTotals(failure?.usage);
        // 失败的尝试与成功的尝试**同等记录**。思考内容与用量都是已经付过钱的产出，
        // 也是唯一能回答「那两分钟发生了什么」的证据。
        this.pushCallLog({
          label,
          ...(options.scope?.workspaceId ? { workspaceId: options.scope.workspaceId } : {}),
          ...(options.scope?.chapterId ? { chapterId: options.scope.chapterId } : {}),
          model: modelRef,
          thinking: attemptThinking,
          ok: false,
          prompt: this.buildPromptText(messages),
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          ...(options.tools?.length ? { tools: options.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) } : {}),
          response: "",
          ...(failure?.toolCalls?.length ? { toolCalls: failure.toolCalls } : {}),
          reasoning: failure?.reasoning,
          ms: Date.now() - attemptStarted,
          usage: failure?.usage,
          ...(failure?.rawStopReason ? { rawStopReason: failure.rawStopReason } : {}),
          ...(failure?.diagnostics ? { diagnostics: failure.diagnostics } : {}),
          error: cause instanceof Error ? cause.message : String(cause),
          attempt: attemptNo,
          attempts: attemptNo,
        });
        // 这次尝试没交付结果，但**已经付过钱**——落一条带 usage 的记录，
        // 否则它在账本上完全不存在（见 WastedAttempt 的注释）。
        const shape = cause as { errorMessage?: string; shapeKind?: LlmResponseShape; diagnostics?: LlmDiagnostic[]; usage?: LlmUsage; reasoningChars?: number; textChars?: number; stopReason?: string; rawStopReason?: string } | null;
        const message = shape?.errorMessage ?? (cause instanceof Error ? cause.message : String(cause));
        wasted.push({
          ...(attemptThinking ? { thinking: attemptThinking } : {}),
          ms: Date.now() - attemptStarted,
          // 形状轴在场就用形状轴；缺席说明这次连消息都没拿到（网络/瞬态），走重试轴。
          // 此前这里比较三条中文文案——分类的依据是结构，不是字符串。
          errorKind: shape?.shapeKind ?? (isRetryableError(message) ? "transient" : "other"),
          ...(shape?.shapeKind ? { shapeKind: shape.shapeKind } : {}),
          ...(shape?.diagnostics ? { diagnostics: shape.diagnostics } : {}),
          ...(shape?.usage ? { usage: shape.usage } : {}),
          ...(shape?.reasoningChars !== undefined ? { reasoningChars: shape.reasoningChars } : {}),
          ...(shape?.textChars !== undefined ? { textChars: shape.textChars } : {}),
          ...(shape?.stopReason ? { stopReason: shape.stopReason } : {}),
          ...(shape?.rawStopReason ? { rawStopReason: shape.rawStopReason } : {}),
          ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        });
        throw cause;
      }
    };
    const runAttempt = async (): Promise<LlmCallResult> => {
      const stream = provider.streamSimple(model, context, {
        reasoning: thinking as never,
        maxTokens: options.maxTokens,
        apiKey: options.apiKey ?? this.resolveKey(modelRef),
        signal: options.signal,
      });

      let final: AssistantMessage | undefined;
      let error: (Error & { errorMessage?: string }) | undefined;
      let ttftMs: number | undefined;
      const pStart = Date.now();
      for await (const event of stream) {
        // TTFT：首个内容事件（start/text/thinking delta）到达耗时（相对本次尝试开始）
        if (ttftMs === undefined && (event.type === "start" || event.type === "text_start" || event.type === "text_delta" || event.type === "thinking_start" || event.type === "thinking_delta")) {
          ttftMs = Date.now() - pStart;
        }
        // 思考增量外发（TR-01）。回调是展示层的，出错不能带垮翻译——
        // 这与账本写失败被吞掉是同一个取舍：辅助设施的故障不该升级成主流程的故障。
        if (event.type === "thinking_delta" && options.onThinking) {
          try { options.onThinking(event.delta); } catch { /* 展示层异常：吞掉 */ }
        }
        // 正文增量。此前这个事件只被用来算 TTFT，内容当场丢弃——而轮 2 的
        // 二十来秒正文产出全在这里，界面上那段黑窗就是这么来的。
        if (event.type === "text_delta" && options.onText) {
          try { options.onText(event.delta); } catch { /* 展示层异常：吞掉 */ }
        }
        // 思考块边界（KA-2）。只有 delta 流的话，「块结束」与「还在想」分不开。
        if (event.type === "thinking_end" && options.onThinkingEnd) {
          try { options.onThinkingEnd(event.contentIndex); } catch { /* 展示层异常：吞掉 */ }
        }
        // 工具调用进度（KA-2）。工具轮的产出全在参数里，不接这三个事件那段时间就是黑屏。
        if (options.onToolCall && (event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end")) {
          const phase = event.type === "toolcall_start" ? "start" as const : event.type === "toolcall_delta" ? "delta" as const : "end" as const;
          try {
            options.onToolCall({
              phase,
              index: event.contentIndex,
              ...(event.type === "toolcall_delta" ? { delta: event.delta } : {}),
              ...(event.type === "toolcall_end"
                ? { toolCall: { id: event.toolCall.id, name: event.toolCall.name, arguments: event.toolCall.arguments as Record<string, unknown> } }
                : {}),
            });
          } catch { /* 展示层异常：吞掉 */ }
        }
        if (event.type === "done") {
          final = event.message;
        } else if (event.type === "error") {
          // 保留 provider errorMessage（重试分类依据）
          const em = event.error.errorMessage ?? "stream error";
          error = new Error(em);
          error.errorMessage = em;
        }
      }
      if (error) throw error;
      if (!final) throw new Error("stream 无最终消息");

      const text = final.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      // 被安全过滤器删除的思考块单独计数、不混进可读文本（KA-2）：它们的 `thinking`
      // 是空的，真载荷在 thinkingSignature 里且不可读。join 进来只会让「被删除」
      // 和「真的什么都没想」在界面上长得一样。完整结构仍在 continuation 里。
      const thinkingBlocks = final.content.filter((c): c is Extract<typeof c, { type: "thinking" }> => c.type === "thinking");
      const reasoning = thinkingBlocks.filter((c) => c.redacted !== true).map((c) => c.thinking).join("");
      const reasoningRedacted = thinkingBlocks.filter((c) => c.redacted === true).length;
      const diagnostics = captureDiagnostics(final.diagnostics);

      // 工具调用（PT-01）：服务商已按 schema 校验过参数形状；真伪校验（词是否
      // 真的在原文里）仍由调用方的 L0 层做——schema 管形状，不管事实。
      const toolCalls = final.content
        .filter((c): c is Extract<typeof c, { type: "toolCall" }> => c.type === "toolCall")
        .map((c) => ({ id: c.id, name: c.name, arguments: c.arguments as Record<string, unknown> }));

      // 「只发工具调用、没有正文」是不是错误，取决于**调用方有没有给工具**（KA-4 验收）。
      //
      // 给了工具，模型按协议发起一轮并让出——这是成功的一轮，不是失败。此前无论调用方
      // 期望什么，这一格一律抛异常，于是 `runToolTurns` 的 `await llm.complete()` 永远
      // 拿不到返回值，第二轮从未组装：三章真机全部 stuck，而模型三章都做对了。
      // 没给工具还收到工具调用，才是真的交付不了译文（服务商或历史里的残留），照旧抛。
      const toolTurnExpected =
        (options.tools?.length ?? 0) > 0
        && final.stopReason !== "length"
        && (final.stopReason === "toolUse" || final.content.some((c) => c.type === "toolCall"));

      if (!text.trim() && !toolTurnExpected) {
        // 没有正文 = 这次调用交付不了译文，必须抛。但**思考块与用量一并带走**：
        // 它们是已经付过钱的产出，也是唯一能回答「那两分钟发生了什么」的证据。
        // 此前这里直接 throw，reasoning 与 usage 当场丢弃，于是失败调用在所有记录里
        // 都是一排 0——真实跑批中我据此做出过两次错误判断。
        //
        // 关于 stopReason：pi-ai 把 API 的 `status:"incomplete"` **一律**映射成
        // `"length"`（openai-responses-shared.js:634 的 switch），并不读
        // `incomplete_details.reason`。所以它只能说明「没正常结束」，
        // **不能**证明是输出预算不够。命名与分类都按这个真实含义来，
        // 不在一个已经丢失信息的字段上假装精确。
        const incomplete = final.stopReason === "length";
        // 「只发了工具调用、没有正文」是**工具协议的正常一轮**，不是空响应（PT-02 实测）：
        // 模型想完就发工具调用并让出，等工具结果回来才产出最终文本。7/7 次尝试
        // （max→off 全档位）行为一致且 rawStopReason 全是 completed——降档治不了它，
        // 那 7 次只是白烧钱。所以这一类**单独成一档**，既不进降档梯子，也带着
        // 工具参数一起上抛：那是已经付过钱、而且合格的产出。
        //
        // 判据以 `stopReason === "toolUse"` 为准（KA-1）：pi 的 done 事件把 reason 收窄成
        // stop | length | toolUse，服务商说是工具轮就是工具轮。此前只数 `toolCalls.length`，
        // 两者在「服务商报 toolUse 但一个调用都没解析出来」这一格必然分叉——数长度会判成
        // 空响应，于是整条降档梯子全部白烧。数数组长度留作没有 toolUse 的服务商的退路。
        const toolOnly = final.stopReason === "toolUse" || (!incomplete && toolCalls.length > 0);
        const shapeKind: LlmResponseShape = incomplete ? "incomplete" : toolOnly ? "tool_call_only" : "empty_response";
        const err = new Error(incomplete
          ? `模型未正常结束（stopReason=${final.stopReason}）且没有正文；已产出 ${reasoning.length} 字符思考。原因需看服务商原始响应`
          : toolOnly
            ? `模型只发了工具调用（${toolCalls.map((c) => c.name).join("、")}）没有正文——工具协议需要把结果回给模型才会产出文本`
            : "模型返回空响应（无文本内容），请重试");
        const shape = err as Error & { errorMessage?: string; shapeKind?: LlmResponseShape; continuation?: AssistantMessage; diagnostics?: LlmDiagnostic[]; reasoningRedacted?: number; usage?: LlmUsage; reasoning?: string; reasoningChars?: number; textChars?: number; stopReason?: string; rawStopReason?: string; responseId?: string; toolCalls?: typeof toolCalls };
        // 分类的依据（KA-1）。文案留着给人看，但**没有任何判断读它**——
        // 三条中文串曾是 llm-runtime 与 translate-one 之间的真实控制流契约，
        // 改一个词要同时改三处，而没有任何东西会红。
        shape.shapeKind = shapeKind;
        shape.errorMessage = incomplete ? "模型未正常结束" : toolOnly ? "模型只发了工具调用" : "模型返回空响应";
        // 失败的那一轮同样要能续接：工具轮本来就是「没有正文」的那一类，
        // 而下一轮必须把这条原始消息（含推理签名与 thoughtSignature）原样回灌。
        shape.continuation = final;
        if (diagnostics) shape.diagnostics = diagnostics;
        if (reasoningRedacted > 0) shape.reasoningRedacted = reasoningRedacted;
        // 工具参数随错误带出：与 reasoning/usage 同一条纪律（TR-02）——
        // 失败的那一次恰恰是最需要证据的时候，而这次的产出全在工具参数里。
        if (toolCalls.length > 0) shape.toolCalls = toolCalls;
        if (final.usage) {
          shape.usage = captureUsage(final.usage);
        }
        shape.reasoning = reasoning;
        shape.reasoningChars = reasoning.length;
        shape.textChars = 0;
        if (final.stopReason) shape.stopReason = final.stopReason;
        // 没有正文时最需要它：归一后的 length 说明不了任何事，原始状态才说得清
        if (final.rawStopReason) shape.rawStopReason = final.rawStopReason;
        if (final.responseId) shape.responseId = final.responseId;
        throw err;
      }

      return {
        // 原始消息排在最前：它是真相，下面几行是它的派生便利值（KA-1）
        continuation: final,
        text,
        reasoning: reasoning || undefined,
        ...(reasoningRedacted > 0 ? { reasoningRedacted } : {}),
        ...(diagnostics ? { diagnostics } : {}),
        ttftMs,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        // cacheWrite 必须一起取：只留 cacheRead 会让「首次写缓存」这种花了钱的调用
        // 在账面上和「彻底没走缓存」长得一模一样。
        usage: final.usage
          ? captureUsage(final.usage)
          : undefined,
        stopReason: final.stopReason,
        // 原始状态与响应标识：归一后的 stopReason 有损，这三样没有
        ...(final.rawStopReason ? { rawStopReason: final.rawStopReason } : {}),
        ...(final.responseId ? { responseId: final.responseId } : {}),
        ...(final.responseModel ? { responseModel: final.responseModel } : {}),
      };
    };

    // 照搬 pi: 瞬态错误指数退避重试（2s/4s/8s × 3）；quota/溢出/非瞬态快速失败；abort 终止
    // 空响应（thinking 占满无 text）→ 自动降 thinking 档重试（max→…→off），避免同档重试浪费
    for (;;) {
      try {
        const settled = await retryCall(produce, errorMessageOf, {
          policy: options.retry,
          signal: options.signal,
          callbacks: options.retryCallbacks,
        });
        // 这一档真的吐出了文本 → 记住它，下次同一模型直接从这里起步。
        if (thinking && THINKING_ORDER.includes(thinking as ThinkingLevel)) workingThinking.set(modelRef, thinking as ThinkingLevel);
        const result: LlmCallResult = {
          ...settled,
          attempts,
          wasted,
          ...(thinking ? { thinking } : {}),
          ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        };
        // 日志已在 produce() 里逐尝试落过（TR-02），这里不再补一条终局记录——
        // 补了会让成功那次尝试出现两遍，而「有几条 = 尝试了几次」是这份日志现在的读法。
        // tokenTotals 同理：produce() 里逐尝试累计过了（TR-12），这里再加就是重复计数。
        return result;
      } catch (cause) {
        const exhausted = (cause as { emptyDowngradeExhausted?: boolean } | null)?.emptyDowngradeExhausted === true;
        // 降档梯子只治「正常结束但无正文」（empty_response）——那是模型真的没话说，
        // 换个档位值得再问一次。
        //
        // 「未正常结束且无正文」（incomplete）**不再进梯子**（TR-12）：实测它的病因是
        // 思考把输出预算整个吃光（medium+ 档整章打草稿，二元开关），降档确实能出文本，
        // 但那是把用户选的档位偷偷换掉、并把整份预算再烧一遍——46 章 × 每章几档，
        // 就是 184 次注定失败的付费调用。正确的退路是**切小任务**，而怎么切只有
        // 调用方知道（translate-one 按段落边界切批）。这里如实上抛，带全 usage/
        // rawStopReason/wasted，上一次「改成终态失败导致 3 章 stuck」的教训是
        // 调用方当时没有退路——现在有了（TR-12 切批兜底），终态才是安全的。
        // 判据是结构化的 `shapeKind`（KA-1）。文本匹配只留给**不经本运行时**的错误
        // （假 LLM、上游包装过的异常）——那时没有形状轴可读，只能退回读消息。
        const failed = cause as { shapeKind?: LlmResponseShape; errorMessage?: string } | null;
        const empty = !exhausted
          && (failed?.shapeKind === "empty_response"
            || (failed?.shapeKind === undefined && failed?.errorMessage === undefined
              && cause instanceof Error && cause.message.includes("空响应")));
        const idx = thinking ? THINKING_ORDER.indexOf(thinking as (typeof THINKING_ORDER)[number]) : -1;
        if (empty && idx > 0) {
          thinking = THINKING_ORDER[idx - 1]!;
          continue; // 降 thinking 档重试
        }
        // 日志同样已在 produce() 里逐尝试落过（TR-02）——每一次废掉的尝试都带着
        // 自己的思考内容与用量各成一条，比这里补一条汇总记录信息量大得多。
        // 失败路径同样要报出尝试次数：账本上「一次就失败」与「重试三次仍失败」
        // 的成本相差三倍，而调用方只拿得到这个异常对象。挂在错误上与 attachErrorKind 同源。
        if (cause && typeof cause === "object") {
          try { (cause as { attempts?: number }).attempts = attempts; } catch { /* 只读错误对象 → 跳过 */ }
          // 失败路径也要带出逐尝试明细：否则一次彻底失败的调用在账本上只剩一行「失败了」，
          // 而它烧掉的每一次尝试、每一份 output 都无从追溯——这正是「出问题查不出原因」的来源。
          try { (cause as { wasted?: WastedAttempt[] }).wasted = wasted; } catch { /* 只读错误对象 → 跳过 */ }
          // 发出去的输出预算：判「触顶」还是「服务商行为」的唯一依据（见 WastedAttempt.maxTokens）
          if (options.maxTokens !== undefined) {
            try { (cause as { maxTokens?: number }).maxTokens = options.maxTokens; } catch { /* 只读错误对象 → 跳过 */ }
          }
        }
        throw attachErrorKind(cause); // 附加结构化分类（auth/quota/溢出/瞬态…）供上层分流
      }
    }
  }
}

