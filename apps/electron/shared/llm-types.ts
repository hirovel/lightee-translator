/**
 * 主进程侧的 LLM 桥类型（RH-07 / M-7）。
 *
 * 之前同一形状在 ipc-service.ts 里被逐字重复了四遍，且 `label` 只存在于其中两处，
 * 于是所有写 label 的地方都要 `(llm as { label?: string })` 强转。此处集中定义后，
 * label 是接口的一部分，强转随之消失。
 *
 * `label` 是 Agent 控制台的调用归类旁路信道（写在桥对象上，由 LlmRuntime 读走）。
 * 机制本身保留——消除它属于发布后 backlog，不在本轮范围内。
 */
/**
 * 单次调用的 token 计量（R0-2），与引擎 `LlmUsage` 同形。
 *
 * `input` 已剔除缓存部分——pi-ai 两条 API 路径都做 `prompt_tokens - cacheRead - cacheWrite`。
 * 提示词总量因此是三者之和，命中率的分母只能取这个和。
 */
export interface LlmUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** `cacheWrite` 中按 1 小时留存写入的部分（只有 Anthropic 拆这一档）。是子集，不另加 */
  cacheWrite1h?: number;
  /**
   * 服务商上报的**推理 token 数**（output 的子集）。TR-11 在引擎侧接住了它，
   * 但这层类型没跟上——于是它到得了 `LlmCallResult`，进不了账本与报告，
   * 「推理占多少」只能继续按字符估。上报值在的时候就该用上报值。
   */
  reasoning?: number;
  /** 输入 + 输出总量（服务商口径） */
  totalTokens?: number;
  /** pi 按模型价目算好的成本。自己再乘一遍只会算错 */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface LlmCallLogEntry {
  id: string;
  label?: string;
  /** 工作区归属（engine 侧 LlmCallOptions.scope 打的戳）。缺席 = 打戳之前的旧记录 */
  workspaceId?: string;
  /** 章节归属（同上） */
  chapterId?: string;
  model: string;
  thinking?: string;
  ok: boolean;
  prompt: string;
  response: string;
  /**
   * 发出去的工具定义（问）与模型发起的工具调用（答）。
   *
   * 两者都不在 `prompt` / `response` 里：KA-5 之后术语登记的指令一个字都不在 prompt
   * （判据在工具 description、形状由 schema 保证），而工具轮的 `response` 是空串。
   * 缺了它们，控制台呈现的是「什么都没告诉模型、模型也什么都没产出」——两句都是假的。
   *
   * ⚠️ 这个 interface 是 engine 侧 `LlmCallLogEntry` 的**手工副本**（跨包边界的类型墙）。
   * 那边加字段这边不跟，症状就是本次遇到的：engine 已经在写这两个字段、dist 里也有，
   * 而这一层的 tsc 说「属性不存在」。改任一侧都要看另一侧。
   */
  tools?: Array<{ name: string; description?: string; parameters?: unknown }>;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  reasoning?: string;
  ms: number;
  ts: number;
  error?: string;
  /** 服务商上报的 token 计量；未上报时缺席（不补 0，否则分不清「没数据」和「真为零」） */
  usage?: LlmUsage;
  /** 服务商原始停止状态（未经映射） */
  rawStopReason?: string;
  /** 服务商侧诊断（KA-2，引擎侧已剔除 details 与 stack）。事后翻查「那两分钟」的地方 */
  diagnostics?: Array<{ type: string; timestamp: number; name?: string; message?: string; code?: string | number }>;
}

export interface LlmMessage {
  role: string;
  content: string;
  /**
   * 续接句柄（KA-1）：上一轮 {@link LlmCallOutcome.continuation} 原样搬回来。
   *
   * 这一层**不看内容**——它是引擎侧的 pi-ai `AssistantMessage`，认识它就等于
   * 让 apps/electron 依赖 pi-ai，而那条边界（electron 里 import pi-ai 的文件数 = 0）
   * 是这套分层唯一还完整的地方。桥只负责搬运。
   *
   * 在场时下面的 `toolCalls` / `reasoning` 全部忽略。
   */
  continuation?: unknown;
  /** assistant 轮发起的工具调用（回灌历史时必须带，PT-02）。仅在没有 continuation 时用 */
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  /** 本条 assistant 的推理内容。DeepSeek 思考模式多轮必须回传，缺它直接 400（PT-02） */
  reasoning?: string;
  /** `role: "toolResult"` 专用：与哪次调用配对 */
  toolCallId?: string;
  toolName?: string;
  toolIsError?: boolean;
}

export interface LlmCallOptions {
  thinking?: string;
  /** 输出预算。translate-one 一直在传（运行时也一直在读），此前只是类型没说实话 */
  maxTokens?: number;
  /**
   * 本次调用的工作区归属，打进调用日志与全局历史文件。thinkingLlm 包装层从
   * run provenance 注入；没有它，Agent 控制台只能把所有书的调用混在一张表里。
   */
  scope?: { workspaceId?: string; chapterId?: string };
  /**
   * 函数工具（PT-01）。结构上与 pi-ai 的 Tool 兼容（name/description/parameters
   * JSON Schema）；桥的各层 Proxy 原样透传，只有 LlmRuntime 消费。
   */
  tools?: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    /**
     * 约束采样（KA-2）。`{ type: "json_schema", strict }` 让 schema 成为
     * **服务商解码层面**的硬约束——没有它，工具调用只是换一种自由文本。
     *
     * `strict` 要求 schema 满足 `additionalProperties: false` 且每个属性都在
     * `required` 里；可选字段只能写成 `"type": ["string", "null"]`。
     * 是否真的生效还取决于 provider 的 `supportsStrictMode`：不支持时
     * `"require"` 抛错、`"prefer"` 静默降级为普通函数工具。
     */
    constrainedSampling?: false | { type: "json_schema"; strict: "prefer" | "require" };
  }>;
  /** 取消信号（RH-16）：透传到底层 fetch，并在调用入口做一次快速失败 */
  signal?: AbortSignal;
  /**
   * 本次调用的归属标签（EX-01）。优先于桥上的 `label` 属性——后者是跨调用共享的
   * 可变状态，并发时谁最后写谁赢。
   */
  label?: string;
  /**
   * 思考块增量回调（TR-03）。由 `thinkingLlm` 代理注入，攒批后经 `agent.thinking`
   * 发到渲染层。引擎侧保证：回调抛异常不影响调用。
   *
   * 红线：delta 含原文与译文草稿，只走进程内 → 渲染层，不落 usage.jsonl 与 AppLog。
   */
  onThinking?: (delta: string) => void;
  /**
   * 译文**正文**增量（engine 的 `onText`）。
   *
   * ⚠️ 与 `LlmCallLogEntry` 同一堵类型墙：这是 engine 侧 `LlmCallOptions` 的手工副本，
   * 那边加回调这边不跟，症状是 tsc 说「属性不存在」。改任一侧都要看另一侧。
   *
   * 红线同 {@link onThinking}：正文只走进程内 → 渲染层，不落 usage.jsonl 与 AppLog。
   */
  onText?: (delta: string) => void;
  /** 思考块结束信号（KA-2）。只有 delta 流时，「块结束」与「还在想」分不开 */
  onThinkingEnd?: (blockIndex: number) => void;
  /**
   * 工具调用进度（KA-2）。工具轮的全部产出都在参数里，不接这三个事件那段时间界面全黑。
   *
   * 红线同 {@link onThinking}：`delta` 里是工具参数（含术语与原文片段），
   * 只走进程内 → 渲染层，不落 usage.jsonl 与 AppLog。
   */
  onToolCall?: (event: { phase: "start" | "delta" | "end"; index: number; delta?: string; toolCall?: { id: string; name: string; arguments: Record<string, unknown> } }) => void;
}

/**
 * 一次调用的返回。`usage` / `ttftMs` / `attempts` 一直由 `LlmRuntime` 原样传回，
 * 只是此前没在类型上声明；用量账本（EX-01）要读它们，就必须让类型说实话。
 * 三者都可缺席：假 LLM 与未上报计量的服务商都不给。
 */
export interface LlmCallOutcome {
  /**
   * 续接句柄（KA-1）：服务商返回的原始 assistant 消息。**本层不解读它**——
   * 拆开就要认识 pi-ai 的类型，而 `apps/electron` 里 import pi-ai 的文件数是 0，
   * 这条边界不能为了一个字段破掉。要多轮时把它原样放进
   * {@link LlmMessage.continuation}，引擎那边知道怎么用。
   */
  continuation?: unknown;
  text: string;
  /** 人可读的思考。**不含被安全过滤器删除的块**，见 {@link reasoningRedacted} */
  reasoning?: string;
  /** 被服务商安全过滤器删除的思考块数量（0 时缺席）。内容不可读，只报个数 */
  reasoningRedacted?: number;
  /**
   * 服务商侧诊断（KA-2）。已在引擎侧剔除 `details` 与 `stack`——
   * 前者可能夹带请求片段（即原文与译文），后者带本机路径。
   */
  diagnostics?: Array<{ type: string; timestamp: number; name?: string; message?: string; code?: string | number }>;
  usage?: LlmUsage;
  ttftMs?: number;
  /** 本次逻辑调用消耗的网络尝试次数（含重试与 thinking 降档） */
  attempts?: number;
  /** 真正拿到文本的那一档；与请求档位不同即发生过降档 */
  thinking?: string;
  /**
   * 服务商给的停止原因。**`length` 不等于「被截断」**——pi-ai 把所有
   * `status:"incomplete"` 一律映射成它，不读 `incomplete_details.reason`。
   * 判触顶要看 output 与 {@link maxTokens}。
   */
  stopReason?: string;
  /**
   * 服务商的**原始**状态，未经 pi-ai 归一映射（responses: completed/incomplete；
   * completions: stop/length/…）。`stopReason` 有损，这一栏没有——
   * `incomplete` 才真正证明「没正常结束」。
   */
  rawStopReason?: string;
  /** 服务商侧的响应标识（跨系统追一次调用的天然锚点） */
  responseId?: string;
  /** 实际服务这次请求的模型（可能带日期后缀） */
  responseModel?: string;
  /** 本次调用发出去的输出预算（未配置时缺席）。见 usage-ledger 的 UsageRecord.maxTokens */
  maxTokens?: number;
  /** 模型发起的工具调用（PT-01）。schema 管形状，真伪校验在引擎 L0 层 */
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  /**
   * 成功之前废掉的尝试。它们没交付结果但**钱照付**——只留 attempts 计数
   * 会让账本少报最贵的那部分（引擎侧 `WastedAttempt` 的字段集）。
   */
  wasted?: Array<{
    thinking?: string;
    ms: number;
    errorKind: string;
    /**
     * 响应形状的原值（KA-1）：`incomplete` / `tool_call_only` / `empty_response`。
     * 缺席说明这次是网络或瞬态失败，连消息都没拿到。
     * `errorKind` 是形状轴与重试轴的并集（账本已在读的历史形态）。
     */
    shapeKind?: string;
    /** 这次尝试的服务商诊断（同上，已剔除 details 与 stack） */
    diagnostics?: Array<{ type: string; timestamp: number; name?: string; message?: string; code?: string | number }>;
    usage?: LlmUsage;
    reasoningChars?: number;
    textChars?: number;
    stopReason?: string;
    /** 服务商原始停止状态。废掉的尝试是唯一需要问「为什么废的」的地方 */
    rawStopReason?: string;
    /** 这次尝试发出去的输出预算。少了它，`output=16384` 只是个孤立数字 */
    maxTokens?: number;
  }>;
}

/**
 * 探测用的临时 provider 配置（`ProviderConfig` 的兼容子集）。
 * 思考能力探测必须用**内存配置**而不是磁盘上那份：探测的做法是每次只放行一个档位
 * （见 `thinking-probe.ts`），把这种临时 map 写进用户的 models.json 再改回来，
 * 中途崩一次就会把「全档位可用」这种没有依据的断言留在配置里。
 */
export interface ProbeProviderConfig {
  name?: string;
  baseUrl?: string;
  api?: "openai-responses" | "openai-completions";
  authKey?: string;
  models?: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number; thinkingLevelMap?: Record<string, string | null> }>;
}

export interface CreateLlmOptions {
  /** 传入则以内存配置构建（不读磁盘 models.json）；密钥仍从 auth.json 解析 */
  providers?: Record<string, ProbeProviderConfig>;
}

export interface LlmBridge {
  // reasoning：服务商是否真的回传了思考内容。探测据此区分「接受参数」与「真的在思考」。
  complete(model: string, messages: LlmMessage[], opts?: LlmCallOptions): Promise<LlmCallOutcome>;
  /** 本次调用的归类标签（translator / reviewer / manager / l2-shard / reduce …） */
  label?: string;
  listModels?(): string[];
  getCallLog?(limit?: number): LlmCallLogEntry[];
  getCallLogById?(id: string): LlmCallLogEntry | undefined;
  /**
   * 跨运行的完整调用历史（持久化文件，新→旧）。
   *
   * `getCallLog` 是本进程的内存环形缓冲（上限 50，重启即空）；历史文件里躺着全部记录。
   * 控制台从前只问前者，于是重启后「上次那批调用」看起来像是消失了——其实一条没丢。
   */
  getHistory?(limit?: number): Promise<LlmCallLogEntry[]>;
  getTokenTotals?(): { input: number; output: number; cacheRead: number; cacheWrite: number };
}
