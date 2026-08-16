/**
 * 服务注入面（RH-11 / design/ipc-service-decomposition.md §2）。
 *
 * `services/*` 之间**不互相 import**；一切共享能力都经这里传递。`IpcService` 在构造时
 * 组装一个实现本接口的对象注入给各服务；服务只看得见接口，看不见彼此。
 *
 * 接口按域分段增长：搬移一个服务就补一段它需要的成员，不要提前塞入还没有消费者的能力。
 */
import type { createServer } from "node:http";
import type { AnyResult } from "../ipc-result.js";
import type { IpcEventMap, IpcEventName, ParagraphDraft, TerminologyStatusSnapshot, WorkspaceInfo } from "../ipc-contract.js";
import type { LlmBridge } from "../llm-types.js";
import type { UsageScope } from "../usage-ledger.js";
import type { BookReviewStateFile, EngineWiring, SourceCorrectionFile, WorkspacePipelineConfig, WorkspaceRecord } from "../service-types.js";

/** 进行中的 OAuth 登录会话。`dispose` 是唯一的收尾出口（清定时器 + 关 server + 摘除条目）。 */
export interface OauthSession {
  promise: Promise<AnyResult>;
  server: ReturnType<typeof createServer>;
  dispose: () => void;
}

export interface ServiceContext {
  // ===== 宿主注入的外壳能力 =====
  /** 用系统默认浏览器打开外部 URL（OAuth 授权页、获取 Key 页面） */
  openExternal(url: string): Promise<boolean>;
  /** 原生目录选择器；宿主未注入时返回 null。title 决定弹窗标题（选工作区 / 选导出位置） */
  pickDirectory(title?: string): Promise<string | null>;
  /** 原生文件选择器；宿主未注入时返回 null */
  pickFile(): Promise<string | null>;
  /** 开发模式（Agent 控制台据此决定是否展示完整调用详情） */
  readonly isDev: boolean;
  /**
   * 运维日志（RH-21 / C-1）。**只写诊断摘要**——命令名、状态转移、错误分类。
   * 绝不传入 payload、prompt、译文正文或密钥：这条红线在 `app-log.ts` 里还有一层
   * 无条件脱敏兜底，但调用点自己也必须守住。宿主未注入时为空实现。
   */
  log(level: "info" | "warn" | "error", message: string): void;
  /** 用系统关联程序打开 Lightee 全局配置文件（models.json / auth.json） */
  openConfigFile(kind: "models" | "auth"): Promise<boolean>;

  // ===== 写入编排（ADR-0005 的队列与在途写追踪，由宿主统一持有） =====
  /**
   * 串行化同一 key 的临界区。read-modify-write **整段**必须进同一个 key，
   * 读改写之间让出会导致并发写互相覆盖且都返回 ok:true（DEF-02）。
   */
  enqueue<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** 登记在途写入，使 `flushPendingWrites`（关窗排水）能等到它完成 */
  trackWrite<T>(promise: Promise<T>): Promise<T>;

  // ===== 引擎与模型 =====
  readonly engine: EngineWiring | null;
  /** 共享 LLM 运行时；为 null 时由 `engine.createLlm()` 现场创建 */
  readonly llm: LlmBridge | null;

  // ===== 工作区与事件 =====
  /** 按 id 取已打开的工作区；不存在时抛 ServiceError(not_found) */
  workspace(workspaceId: string): WorkspaceRecord;
  /** 扫描磁盘重建工作区概览（卷/章节树）。结构变更后用它刷新注册表快照 */
  workspaceInfo(root: string, openedAt?: number): Promise<WorkspaceInfo>;
  /** 把最新概览写回工作区注册表（最近打开列表的唯一写权威） */
  touchRegistry(info: WorkspaceInfo): Promise<void>;
  /** 向 renderer 推送任意契约事件 */
  emit<K extends IpcEventName>(type: K, payload: IpcEventMap[K]): void;
  /** 向 renderer 推送 Agent 状态事件（含来源范围，供工作台按 workspace/chapter 过滤） */
  emitAgentStatus(
    agent: string,
    status: IpcEventMap["agent.status"]["status"],
    message: string,
    provenance: Partial<Pick<IpcEventMap["agent.status"], "workspaceId" | "chapterId" | "runId" | "operation" | "kind">>,
  ): void;

  /** 工作区级 revision 计数（settings / chapter / reviewRules 共用一份 `state/ipc-revisions.json`） */
  readRevision(root: string, key: string): Promise<number>;
  writeRevision(root: string, key: string, revision: number): Promise<void>;

  // ===== 跨域读取（服务之间不互相 import，一律经此） =====
  /** 工作区解析后的流水线配置（模型/思考强度/分批/上下文窗口）。术语与翻译编排都要用 */
  pipelineConfig(root: string): Promise<WorkspacePipelineConfig>;
  /** 审校类 LLM 的模型与思考强度（与翻译分开：结构化 JSON 审校用低思考更稳） */
  resolveReviewAgent(root: string): Promise<{ model: string; thinking: string }>;
  /** 作者对导入原文的修正；翻译前要拿它替换源文 */
  readSourceCorrectionFile(root: string, chapterId: string): Promise<SourceCorrectionFile | null>;
  sourceCorrectionPath(root: string, chapterId: string): string;
  /** 术语准备状态（含「已确认」的有效判定）。翻译前置门禁要读它 */
  readEffectiveTerminologyStatus(root: string): Promise<TerminologyStatusSnapshot>;

  // ===== 长任务取消（RH-16 / A-3） =====
  /** 注册一个可取消的运行；返回 signal 与必须在 finally 调用的注销函数 */
  beginCancellable(runKey: string): { signal: AbortSignal; end: () => void };
  /**
   * 按 runKey 中止一个进行中的运行（RS-1 两段式停止的第二击）。
   * 与 `translate.cancel` 同一张取消表——跑批停当前章走的就是单章取消那条路。
   */
  requestCancel(runKey: string): "idle" | "cancelling";
  /**
   * 系统通知（RS-1 / D13）：跑批结束后用户多半不在窗口前。宿主未注入时为空实现。
   * `onClick` 由宿主在聚焦窗口**之后**回调——服务层用它发「通知被点击」的契约事件。
   */
  notify(notice: { title: string; body: string; onClick?: () => void }): void;
  /** 包一层 LLM：signal 触发后续调用立即抛 CancelledError，而不是等模型返回 */
  cancellableLlm(llm: LlmBridge, signal: AbortSignal): LlmBridge;
  /**
   * 包一层 LLM：每次调用往工作区账本 `sessions/usage.jsonl` 落一行纯数字（EX-01），
   * 并在 `scope.totals` 上就地累加供运行结束后生成摘要。
   *
   * 与 {@link cancellableLlm} 同一个装配范式，可叠加。调用点只多一行，
   * 而不必把记账参数一路透传进引擎。
   */
  usageLlm(llm: LlmBridge, scope: UsageScope): LlmBridge;
  /**
   * 给 LLM 桥套上思考直播（TR-03）：`thinking_delta` 攒批后经 `agent.thinking` 发到渲染层。
   *
   * 与 {@link cancellableLlm} / {@link usageLlm} 同一装配范式，可叠加；
   * 装在**最内层**——外层的取消与记账都不该被展示挡住。
   */
  thinkingLlm(llm: LlmBridge, provenance: { workspaceId?: string; chapterId?: string; runId?: string }): LlmBridge;
  /** 取消后把章节状态收敛回一个合法静止态（绝不留在 translating） */
  settleCancelledChapter(root: string, chapterId: string): Promise<void>;
  /** 由工作区根路径反查已打开的 workspaceId（事件里要带上来源范围） */
  workspaceIdForRoot(root: string): string | undefined;

  // ===== 打开/关闭工作区时的跨域联动 =====
  /** 打开工作区时启动术语仓库轮询；只对真正打开的工作区起（RH-20） */
  startTerminologyWatcher(workspace: WorkspaceRecord): void;
  /** 关闭工作区时停掉轮询，否则定时器会一直跑到进程退出 */
  stopTerminologyWatcher(root: string): void;
  /** 打开工作区时清理超期的回收站批次 */
  pruneExpiredTrash(root: string): Promise<void>;
  /** 全书批准状态。导出门禁要读它，但导出服务不该认识 workflow 服务 */
  readBookReviewState(root: string): Promise<BookReviewStateFile>;
  /**
   * 使全书 AI 审校基线失效。翻译指南、术语表、源文修改都会触发——
   * 各域都要用，因此走注入面单点，而不是让服务互相 import（design §3.3）。
   */
  markBookReviewStale(root: string, reason: string): Promise<void>;
  /** 导入新原文后使术语「已扫描」状态失效（只改标志，不动已确认的术语档案） */
  markTerminologyStale(root: string, reason: string): Promise<void>;
  /** 作者手动改稿 → 全书审校基线记为「作者已编辑」（与 AI 失效区分开） */
  markBookReviewAuthorEdited(root: string): Promise<void>;
  /**
   * 草稿保存后把段落回写进 `state/paragraphs`。全文审校按段落定位问题，
   * 段落表和草稿一旦脱节，审校报告会指向不存在的位置。
   */
  syncParagraphsFromDraft(root: string, chapterId: string, drafts: ParagraphDraft[]): Promise<void>;

  // ===== OAuth =====
  /** OAuth 登录会话表。跨命令共享（login 建 / wait 消费 / 下一次 login 取代） */
  readonly oauthSessions: Map<string, OauthSession>;
}
