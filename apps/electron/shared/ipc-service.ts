/**
 * IPC 宿主（RH-11 / design/ipc-service-decomposition.md）。
 *
 * 分解后本文件只剩四件事，业务逻辑一律在 `services/*`：
 * 1. **装配**：构造各服务，并组装它们唯一能看见的注入面 `ServiceContext`。
 * 2. **分发**：`dispatch` 的 switch 是「命令 → 模块归属」的权威清单——
 *    要知道某条命令归谁管，看这张表，不要去 grep。
 * 3. **进程级编排**：事件广播、写队列与在途写追踪、关窗排水、长任务取消。
 * 4. **错误归一**：把领域异常映射成契约错误码。
 */
import { resolve } from "node:path";
import { readRevision, writeRevision } from "./revision-store.js";
import { PRESET_PROVIDERS } from "./lightee-config.js";
import type { LlmBridge, LlmCallOptions, LlmMessage } from "./llm-types.js";
import { accumulate, appendUsage, type UsageRecord, type UsageScope } from "./usage-ledger.js";
import { ThinkingBuffer } from "./thinking-stream.js";
import { ParagraphTextStream } from "./paragraph-stream.js";
import { CancelledError } from "./cancellation.js";
import { errorFor, failure, success, ServiceError, type AnyResult } from "./ipc-result.js";
import type { EngineWiring } from "./service-types.js";
import { OauthService } from "./services/oauth-service.js";
import { DialogService } from "./services/dialog-service.js";
import { ExportService } from "./services/export-service.js";
import { AgentLogService } from "./services/agent-log-service.js";
import { ConfigService } from "./services/config-service.js";
import { StructureService } from "./services/structure-service.js";
import { ChapterIoService } from "./services/chapter-io-service.js";
import { TerminologyService } from "./services/terminology-service.js";
import { WorkflowService, bookReviewRunKey, translateRunKey } from "./services/workflow-service.js";
import { WorkspaceService } from "./services/workspace-service.js";
import type { OauthSession, ServiceContext } from "./services/service-context.js";
export { hasTranslatableBody } from "./source-body.js";
import {
  ChapterStateStore,
  ConfirmSessionConflictError,
  TerminologyRepositoryError,
  type ChapterWorkflowStatus,
} from "@lightee/engine";
import {
  IPC_VERSION,
  type CancelResult,
  type FlushResult,
  type IpcEnvelope,
  type IpcEvent,
  type IpcEventMap,
  type IpcEventName,
  type IpcRequestMap,
  type IpcResult,
  validateEnvelope,
} from "./ipc-contract.js";

/** `IpcService` 的构造参数。构造函数与 `createIpcService` 共用同一份，避免两处签名漂移 */
export interface IpcServiceOptions {
  pickDirectory?: (title?: string) => Promise<string | null>;
  pickFile?: () => Promise<string | null>;
  engine?: EngineWiring | null;
  llm?: LlmBridge | null;
  isDev?: boolean;
  registryPath?: string | null;
  terminologyWatcher?: boolean;
  /** 打开配置文件（main 进程 shell.openPath 注入） */
  openConfigFile?: (kind: "models" | "auth") => Promise<boolean>;
  openExternal?: (url: string) => Promise<boolean>;
  /** 运维日志落盘（RH-21 / C-1）。未注入时静默丢弃——测试与库用法不该产生文件 */
  log?: (level: "info" | "warn" | "error", message: string) => void;
  /** 系统通知（RS-1 / D13，main 进程 Notification 注入）。未注入时静默丢弃 */
  notify?: (notice: { title: string; body: string; onClick?: () => void }) => void;
  /** 打开工作区时自动快照（RH-21 / C-2）。同 log，默认关闭 */
  autoSnapshot?: boolean;
}

type EventListener = (event: IpcEvent) => void;

/** 真实 engine 接线（由 main-ipc 构造注入；测试注入 fake/真实 engine） */
export type { EngineWiring } from "./service-types.js";
export class IpcService {
  private readonly pickDirectory: (title?: string) => Promise<string | null>;
  private readonly pickFile: () => Promise<string | null>;
  private readonly engine: EngineWiring | null;
  private readonly llm: LlmBridge | null;
  private readonly isDev: boolean;
  private readonly enableTerminologyWatcher: boolean;
  private readonly registryPath: string | null;
  private readonly openConfigFile: (kind: "models" | "auth") => Promise<boolean>;
  private readonly oauthSessions = new Map<string, OauthSession>();
  private readonly openExternal: (url: string) => Promise<boolean>;
  private readonly log: (level: "info" | "warn" | "error", message: string) => void;
  private readonly notify: (notice: { title: string; body: string; onClick?: () => void }) => void;
  private readonly autoSnapshot: boolean;
  /** 进行中的可取消长任务（RH-16）：runKey → AbortController */
  private readonly cancellations = new Map<string, AbortController>();

  constructor(options: IpcServiceOptions = {}) {
    this.pickDirectory = options.pickDirectory ?? (async () => null);
    this.pickFile = options.pickFile ?? (async () => null);
    this.openConfigFile = options.openConfigFile ?? (async () => false);
    this.openExternal = options.openExternal ?? (async () => false);
    this.log = options.log ?? (() => {});
    this.notify = options.notify ?? (() => {});
    this.autoSnapshot = options.autoSnapshot ?? false;
    this.engine = options.engine ?? null;
    this.llm = options.llm ?? null;
    this.isDev = options.isDev ?? false;
    this.enableTerminologyWatcher = options.terminologyWatcher ?? false;
    this.registryPath = options.registryPath ?? null;
    this.serviceContext = {
      openExternal: (url) => this.openExternal(url),
      pickDirectory: (title) => this.pickDirectory(title),
      pickFile: () => this.pickFile(),
      isDev: this.isDev,
      engine: this.engine,
      llm: this.llm,
      workspace: (workspaceId) => this.workspaces.workspace(workspaceId),
      emitAgentStatus: (agent, status, message, provenance) => this.emitAgentStatus(agent, status, message, provenance),
      readBookReviewState: (root) => this.workflow.readBookReviewState(root),
      oauthSessions: this.oauthSessions,
      openConfigFile: (kind) => this.openConfigFile(kind),
      log: (level, message) => this.log(level, message),
      enqueue: (key, fn) => this.enqueue(key, fn),
      trackWrite: (promise) => this.trackWrite(promise),
      readRevision,
      writeRevision,
      markBookReviewStale: (root, reason) => this.workflow.markBookReviewStale(root, reason),
      markTerminologyStale: (root, reason) => this.terminology.markTerminologyStale(root, reason),
      workspaceInfo: (root, openedAt) => this.workspaces.workspaceInfo(root, openedAt),
      touchRegistry: (info) => this.workspaces.touchRegistry(info),
      emit: (type, payload) => this.emit(type, payload),
      markBookReviewAuthorEdited: (root) => this.workflow.markBookReviewAuthorEdited(root),
      syncParagraphsFromDraft: (root, chapterId, drafts) => this.workflow.syncParagraphsFromDraft(root, chapterId, drafts),
      pipelineConfig: (root) => this.config.pipelineConfig(root),
      resolveReviewAgent: (root) => this.config.resolveReviewAgent(root),
      readSourceCorrectionFile: (root, chapterId) => this.chapterIo.readSourceCorrectionFile(root, chapterId),
      sourceCorrectionPath: (root, chapterId) => this.chapterIo.sourceCorrectionPath(root, chapterId),
      readEffectiveTerminologyStatus: (root) => this.terminology.readEffectiveTerminologyStatus(root),
      beginCancellable: (runKey) => this.beginCancellable(runKey),
      requestCancel: (runKey) => this.abortRun(runKey),
      notify: (notice) => this.notify(notice),
      cancellableLlm: (llm, signal) => this.cancellableLlm(llm, signal),
      usageLlm: (llm, scope) => this.usageLlm(llm, scope),
      thinkingLlm: (llm, provenance) => this.thinkingLlm(llm, provenance),
      settleCancelledChapter: (root, chapterId) => this.settleCancelledChapter(root, chapterId),
      workspaceIdForRoot: (root) => this.workspaceIdForRoot(root),
      startTerminologyWatcher: (workspace) => this.terminology.startTerminologyWatcher(workspace),
      stopTerminologyWatcher: (root) => this.terminology.stopTerminologyWatcher(root),
      pruneExpiredTrash: (root) => this.structure.pruneExpiredTrash(root),
    };
    this.oauth = new OauthService(this.serviceContext);
    this.dialogs = new DialogService(this.serviceContext);
    this.exports = new ExportService(this.serviceContext);
    this.agentLogs = new AgentLogService(this.serviceContext);
    this.config = new ConfigService(this.serviceContext);
    this.structure = new StructureService(this.serviceContext);
    this.chapterIo = new ChapterIoService(this.serviceContext);
    this.terminology = new TerminologyService(this.serviceContext, this.enableTerminologyWatcher);
    this.workflow = new WorkflowService(this.serviceContext);
    this.workspaces = new WorkspaceService(this.serviceContext, this.registryPath, this.autoSnapshot);
  }

  /**
   * 服务注入面（design/ipc-service-decomposition.md §2）。服务只看得见这个对象，
   * 看不见 `IpcService` 本身，也看不见彼此——跨域能力必须先在这里显式暴露。
   */
  // 注意：这些必须在构造函数**末尾**赋值，不能用字段初始化器——字段初始化器先于
  // 构造函数体运行，那时 engine / llm / isDev 还没赋值，注入面会捕获到 undefined。
  private readonly serviceContext: ServiceContext;
  private readonly oauth: OauthService;
  private readonly dialogs: DialogService;
  private readonly exports: ExportService;
  private readonly agentLogs: AgentLogService;
  private readonly config: ConfigService;
  private readonly structure: StructureService;
  private readonly chapterIo: ChapterIoService;
  private readonly terminology: TerminologyService;
  private readonly workflow: WorkflowService;
  private readonly workspaces: WorkspaceService;

  private readonly listeners = new Set<EventListener>();
  private readonly mutations = new Map<string, Promise<unknown>>();
  private readonly pendingWrites = new Set<Promise<unknown>>();
  private closing = false;

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 仅测试/诊断用：进行中的 OAuth 登录会话数（M-3 清理的可观测点） */
  oauthSessionCount(): number {
    return this.oauthSessions.size;
  }

  /** 仅测试/诊断用：正在轮询的术语 watcher 数（RH-20 / B-2 的可观测点） */
  terminologyWatcherCount(): number {
    return this.terminology.watcherCount();
  }

  markClosing(): void {
    this.closing = true;
    this.terminology.stopAllWatchers();
    // RS-1：跑批可能还有几十章没开工。关窗排空只等**在飞的写入**，不该再放新章开工——
    // 不停的话 flush 等完当前章，循环又启动下一章，排空永远追不上。
    this.workflow.stopScopeRunsForShutdown();
  }

  async flushPendingWrites(): Promise<IpcResult<FlushResult>> {
    const pending = [...this.pendingWrites];
    if (pending.length === 0) {
      return success({ status: "already-drained", pendingAtStart: 0, completedAt: Date.now() });
    }
    await Promise.allSettled(pending);
    return success({ status: "drained", pendingAtStart: pending.length, completedAt: Date.now() });
  }

  async invoke(input: unknown): Promise<AnyResult> {
    const envelope = validateEnvelope(input);
    if (!envelope.ok) return envelope;
    if (this.closing) return failure(errorFor("shutdown", "The application is shutting down", true));

    try {
      return await this.dispatch(envelope.value);
    } catch (error) {
      if (error instanceof ServiceError) return failure(error.ipcError);
      if (error instanceof TerminologyRepositoryError) {
        const mapped = this.terminology.repositoryError(error);
        if (mapped) return failure(mapped);
      }
      if (error instanceof ConfirmSessionConflictError) return failure(errorFor("conflict", error.message, false));
      const message = error instanceof Error ? error.message : "Unknown IPC failure";
      // C-1：internal 是「不该发生」的一类，必须留下现场。只记命令名与消息——
      // payload 里有原文/译文/密钥，一律不进日志。
      this.log("error", `ipc internal ${envelope.value.command}: ${message}`);
      return failure(errorFor("internal", message.slice(0, 512), true));
    }
  }

  private emit<K extends IpcEventName>(type: K, payload: IpcEventMap[K]): void {
    const event = { version: IPC_VERSION, type, emittedAt: Date.now(), payload } as IpcEvent;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One renderer-side observer must not turn a committed IPC mutation into a failure.
      }
    }
  }

  private emitAgentStatus(
    agent: string,
    status: IpcEventMap["agent.status"]["status"],
    message: string,
    provenance: Pick<IpcEventMap["agent.status"], "workspaceId" | "chapterId" | "runId" | "operation">,
  ): void {
    this.emit("agent.status", { agent, status, message, ...provenance });
  }

  private workspaceIdForRoot(root: string): string | undefined {
    const resolved = resolve(root);
    for (const [workspaceId, workspace] of this.workspaces.openWorkspaces()) {
      if (resolve(workspace.root) === resolved) return workspaceId;
    }
    return undefined;
  }

  private trackWrite<T>(promise: Promise<T>): Promise<T> {
    this.pendingWrites.add(promise);
    void promise.then(
      () => this.pendingWrites.delete(promise),
      () => this.pendingWrites.delete(promise),
    );
    return promise;
  }

  private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.mutations.set(key, next.catch(() => undefined));
    return next;
  }

  // ===== 长任务取消（RH-16 / A-3）=====

  /** 注册一个可取消的运行；返回 signal 与必须在 finally 调用的注销函数 */
  private beginCancellable(runKey: string): { signal: AbortSignal; end: () => void } {
    this.cancellations.get(runKey)?.abort();
    const controller = new AbortController();
    this.cancellations.set(runKey, controller);
    return {
      signal: controller.signal,
      end: () => {
        if (this.cancellations.get(runKey) === controller) this.cancellations.delete(runKey);
      },
    };
  }

  /** 取消请求：payload → 工作区根 → runKey。工作区未打开时 `workspace()` 抛 not_found */
  private cancelRun<P extends { workspaceId: string }>(payload: P, keyOf: (root: string, payload: P) => string): AnyResult {
    return this.requestCancel(keyOf(this.workspaces.workspace(payload.workspaceId).root, payload));
  }

  private requestCancel(runKey: string): AnyResult {
    return success({ status: this.abortRun(runKey) } satisfies CancelResult);
  }

  /** 取消的最小核心：命中则 abort。IPC 命令与跑批的第二击（RS-1）共用这一张表 */
  private abortRun(runKey: string): "idle" | "cancelling" {
    const controller = this.cancellations.get(runKey);
    if (!controller) return "idle";
    controller.abort();
    return "cancelling";
  }

  /**
   * 给 LLM 桥套上取消语义：调用入口快速失败 + 把 signal 透传到底层 fetch。
   *
   * 用 Proxy 而不是新对象，是因为管线沿途会往桥上写 `label`（Agent 控制台归类的旁路信道）——
   * 写到包装对象上就丢了。默认 set 陷阱直接落到目标对象。
   */
  private cancellableLlm(llm: LlmBridge, signal: AbortSignal): LlmBridge {
    return new Proxy(llm, {
      get(target, prop, receiver) {
        if (prop !== "complete") return Reflect.get(target, prop, receiver);
        return (model: string, messages: Array<{ role: string; content: string }>, opts?: { thinking?: string }) => {
          if (signal.aborted) return Promise.reject(new CancelledError());
          return target.complete(model, messages, { ...opts, signal });
        };
      },
    });
  }

  /**
   * 给 LLM 桥套上思考直播（TR-03）：把 `thinking_delta` 攒批后经 `agent.thinking` 发给渲染层。
   *
   * 与 {@link cancellableLlm}／{@link usageLlm} 同一个 Proxy 范式（沿途会往桥上写 `label`）。
   * 装配在**最内层**：外层的取消与记账都不该被展示挡住，而展示要看到真正发出去的那一次。
   *
   * 每次逻辑调用一个缓冲。降档重试会连着发多个块，`attempt` 区分它们——
   * 用户因此看得见「这是第 3 次了」，而不是一个转了六分钟的秒表。
   *
   * 红线：delta 含原文与译文草稿，只走进程内 → 渲染层，不落 usage.jsonl 与 AppLog。
   */
  private thinkingLlm(llm: LlmBridge, provenance: { workspaceId?: string; chapterId?: string; runId?: string }): LlmBridge {
    return new Proxy(llm, {
      get: (target, prop, receiver) => {
        if (prop !== "complete") return Reflect.get(target, prop, receiver);
        return async (model: string, messages: LlmMessage[], opts?: LlmCallOptions) => {
          const label = opts?.label ?? "";
          let attempt = 0;
          let buffer: ThinkingBuffer | undefined;
          const onThinking = (delta: string): void => {
            if (!buffer) {
              attempt += 1;
              const at = attempt;
              buffer = new ThinkingBuffer((text, done) => {
                this.emit("agent.thinking", {
                  label,
                  attempt: at,
                  ...(opts?.thinking ? { thinking: opts.thinking } : {}),
                  delta: text,
                  ...(done ? { done: true } : {}),
                  ...provenance,
                });
              });
            }
            buffer.push(delta);
          };

          /**
           * 思考**块**收尾（KA-2 的 `onThinkingEnd`，此前没有任何消费方）。
           *
           * 从前 `buffer.finish()` 只挂在整次调用结束的 `finally` 上，于是思考块的
           * 「结束」绑的是**调用结束**而不是思考结束。实测后果：轮 2 全长 22 秒、
           * 思考只有几十字符，界面却在剩下二十来秒里一直显示「正在思考」——
           * 那二十秒模型在写正文。思考停了就说停了，这是最基本的不撒谎。
           *
           * 顺带修正 `attempt` 的语义：从前缓冲只在整次调用里建一次，于是**重试的思考
           * 全都挂在 attempt=1 上**，「这是第 3 次了」从来没真的显示对过。现在一块一号。
           * 依据的假设是「一次网络尝试一个思考块」——实测三轮都是如此（每轮各一块）；
           * 若将来观测到一次尝试吐多块，这个编号会偏大，届时改用 blockIndex 判重。
           */
          const onThinkingEnd = (): void => {
            buffer?.finish();
            buffer = undefined;
          };

          // 正文流。剥离器把 wire 标签摘掉，攒批复用思考那一套（同样的时间窗与体积阈值）——
          // 正文的到达节奏与思考同量级，没有理由为它单独调一套参数。
          const paragraphs = new ParagraphTextStream();
          let textBuffer: ThinkingBuffer | undefined;
          let textParagraphId = "";
          const emitText = (text: string, done: boolean): void => {
            this.emit("agent.text", {
              label,
              ...(attempt > 0 ? { attempt } : {}),
              paragraphId: textParagraphId,
              delta: text,
              ...(done ? { done: true } : {}),
              ...provenance,
            });
          };
          const pushChunks = (chunks: ReadonlyArray<{ paragraphId: string; text: string }>): void => {
            for (const chunk of chunks) {
              // 换段就把上一段冲干净再换 id，否则两段的文字会挂在同一个 paragraphId 下发出去
              if (chunk.paragraphId !== textParagraphId) {
                textBuffer?.finish();
                textBuffer = undefined;
                textParagraphId = chunk.paragraphId;
              }
              if (!textBuffer) textBuffer = new ThinkingBuffer(emitText);
              textBuffer.push(chunk.text);
            }
          };
          const onText = (delta: string): void => { pushChunks(paragraphs.push(delta)); };

          try {
            // scope 戳（顺带的第四职责）：这一层是唯一带着 run provenance 又直达运行时的
            // 包装，工作区归属从这里进调用日志——没有它，全局历史在控制台里分不出书。
            return await target.complete(model, messages, {
              ...opts,
              ...(provenance.workspaceId || provenance.chapterId
                ? { scope: { ...(provenance.workspaceId ? { workspaceId: provenance.workspaceId } : {}), ...(provenance.chapterId ? { chapterId: provenance.chapterId } : {}) } }
                : {}),
              onThinking, onThinkingEnd, onText,
            });
          } finally {
            // 无论成败都要收尾：少了这一下，界面会永远停在「正在思考」上。
            buffer?.finish();
            pushChunks(paragraphs.finish());
            textBuffer?.finish();
          }
        };
      },
    });
  }

  /**
   * 给 LLM 桥套上记账（EX-01）：每次调用往 `sessions/usage.jsonl` 落一行纯数字。
   *
   * 同样用 Proxy 而不是新对象——理由与 {@link cancellableLlm} 一致（沿途会往桥上写 `label`）。
   *
   * 装配顺序是 `cancellableLlm(usageLlm(base))`：取消在**外**层快速失败，因此
   * 「signal 已 abort、根本没发出去」的调用不会在账本上留下一次假消费；而已经发出、
   * 中途被 abort 的调用走的是内层的 catch，如实记为失败——它可能真的烧了 token。
   */
  private usageLlm(llm: LlmBridge, scope: UsageScope): LlmBridge {
    const record = (row: UsageRecord): void => {
      accumulate(scope.totals, row);
      // 账本写入进单写者队列 + 在途登记：关窗排空要等得到它，否则最后几次调用的账丢了。
      void this.trackWrite(this.enqueue(`usage:${scope.root}`, () => appendUsage(scope.root, row)));
    };
    return new Proxy(llm, {
      get: (target, prop, receiver) => {
        if (prop !== "complete") return Reflect.get(target, prop, receiver);
        return async (model: string, messages: LlmMessage[], opts?: LlmCallOptions) => {
          const startedAt = Date.now();
          // 引擎侧显式传的标签更细（含阶段），不覆盖；没传才用本次运行的范围标签。
          const label = opts?.label ?? scope.label;
          try {
            const result = await target.complete(model, messages, { ...opts, label });
            // 废掉的尝试各自成行。它们没交付结果，但**钱照付**——只留一个 attempts 计数
            // 会让账本少报最贵的那部分（2026-08-12 实测：7 次逻辑调用背后 27 次尝试，
            // 20 次废掉，账面上一个 token 都看不见）。
            let index = 0;
            for (const attempt of result.wasted ?? []) {
              index += 1;
              record({
                ts: startedAt,
                label,
                model,
                ...(attempt.thinking ? { thinking: attempt.thinking } : {}),
                ...(opts?.thinking ? { thinkingRequested: opts.thinking } : {}),
                attempt: index,
                attempts: 1,
                ok: false,
                ms: attempt.ms,
                input: attempt.usage?.input ?? 0,
                output: attempt.usage?.output ?? 0,
                cacheRead: attempt.usage?.cacheRead ?? 0,
                cacheWrite: attempt.usage?.cacheWrite ?? 0,
                ...(attempt.reasoningChars === undefined ? {} : { reasoningChars: attempt.reasoningChars }),
                ...(attempt.textChars === undefined ? {} : { textChars: attempt.textChars }),
                ...(attempt.usage?.reasoning === undefined ? {} : { reasoning: attempt.usage.reasoning }),
                ...(attempt.stopReason ? { stopReason: attempt.stopReason } : {}),
                ...(attempt.rawStopReason ? { rawStopReason: attempt.rawStopReason } : {}),
                // 发出去的预算。少了它，报告只能说「原因未知」，而 output 精确停在
                // 16384 上——答案就在旁边却报不出来（两次跑批 8/8 都是这样）。
                ...(attempt.maxTokens === undefined ? {} : { maxTokens: attempt.maxTokens }),
                errorKind: attempt.errorKind,
              });
            }
            record({
              ts: startedAt,
              label,
              model,
              // thinking 记**生效**档位、thinkingRequested 记请求档位。
              // 此前这里只记请求档位，于是账本说 max、历史日志说 low，两份记录自相矛盾。
              ...(result.thinking ?? opts?.thinking ? { thinking: result.thinking ?? opts?.thinking } : {}),
              ...(opts?.thinking ? { thinkingRequested: opts.thinking } : {}),
              attempt: index + 1,
              attempts: result.attempts ?? 1,
              ok: true,
              ms: Date.now() - startedAt,
              ...(result.ttftMs === undefined ? {} : { ttftMs: result.ttftMs }),
              input: result.usage?.input ?? 0,
              output: result.usage?.output ?? 0,
              cacheRead: result.usage?.cacheRead ?? 0,
              cacheWrite: result.usage?.cacheWrite ?? 0,
              reasoningChars: (result.reasoning ?? "").length,
              textChars: result.text.length,
              // 服务商上报的推理 token 数与原始停止状态（TR-12）：报告有它们
              // 才能不靠字符估算、不把「所有 incomplete」当一种病
              ...(result.usage?.reasoning === undefined ? {} : { reasoning: result.usage.reasoning }),
              ...(result.stopReason ? { stopReason: result.stopReason } : {}),
              ...(result.rawStopReason ? { rawStopReason: result.rawStopReason } : {}),
              ...(result.maxTokens === undefined ? {} : { maxTokens: result.maxTokens }),
            });
            return result;
          } catch (error) {
            // **只记分类，不记 message**：服务商的错误消息里可能回显输入片段，
            // 而账本是一个用户会打包发给别人排障的文件。
            const failure = error as {
              kind?: string; attempts?: number;
              wasted?: Array<{ thinking?: string; ms: number; errorKind: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number }; reasoningChars?: number; textChars?: number; stopReason?: string; rawStopReason?: string; maxTokens?: number }>;
              maxTokens?: number;
            } | null;
            // 失败路径与成功路径**同等记录**。此前这里写死 input/output=0 且不带逐尝试
            // 明细，于是一次彻底失败的调用在账本上只剩一行「失败了」——而出问题的时候
            // 恰恰是最需要溯源的时候。真实跑批里我据此做出过两次错误判断。
            let index = 0;
            for (const attempt of failure?.wasted ?? []) {
              index += 1;
              record({
                ts: startedAt,
                label,
                model,
                ...(attempt.thinking ? { thinking: attempt.thinking } : {}),
                ...(opts?.thinking ? { thinkingRequested: opts.thinking } : {}),
                attempt: index,
                attempts: 1,
                ok: false,
                ms: attempt.ms,
                input: attempt.usage?.input ?? 0,
                output: attempt.usage?.output ?? 0,
                cacheRead: attempt.usage?.cacheRead ?? 0,
                cacheWrite: attempt.usage?.cacheWrite ?? 0,
                ...(attempt.reasoningChars === undefined ? {} : { reasoningChars: attempt.reasoningChars }),
                ...(attempt.textChars === undefined ? {} : { textChars: attempt.textChars }),
                ...(attempt.usage?.reasoning === undefined ? {} : { reasoning: attempt.usage.reasoning }),
                ...(attempt.stopReason ? { stopReason: attempt.stopReason } : {}),
                ...(attempt.rawStopReason ? { rawStopReason: attempt.rawStopReason } : {}),
                // 发出去的预算。少了它，报告只能说「原因未知」，而 output 精确停在
                // 16384 上——答案就在旁边却报不出来（两次跑批 8/8 都是这样）。
                ...(attempt.maxTokens === undefined ? {} : { maxTokens: attempt.maxTokens }),
                errorKind: attempt.errorKind,
              });
            }
            const kind = failure?.kind ?? (error instanceof Error ? error.constructor.name : typeof error);
            // 终态行只在 `wasted` 为空时补——那种失败发生在任何一次网络尝试之前
            // （鉴权、配置、参数），不补就在账本上完全不存在。
            //
            // `wasted` 非空时它是**幻影**：每一次网络尝试上面已经各落一行，这行再加一次，
            // 用量全 0、errorKind 落到「unknown」。KA-4 验收当天的报告因此说「尝试 6 次，
            // 废因 tool_call_only ×3 · unknown ×3」，而 llm-history 里只有 3 次调用——
            // 账本把真实次数翻了一倍，废因分布里一半是虚构的。token 没多算（幻影行是 0），
            // 但「几次尝试」「为什么废的」这两个问题它答错了，而账本存在的意义就是答这两问。
            if ((failure?.wasted?.length ?? 0) > 0) throw error;
            record({
              ts: startedAt,
              label,
              model,
              ...(opts?.thinking ? { thinking: opts.thinking, thinkingRequested: opts.thinking } : {}),
              attempt: index + 1,
              attempts: failure?.attempts ?? 1,
              ok: false,
              ms: Date.now() - startedAt,
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              ...(failure?.maxTokens === undefined ? {} : { maxTokens: failure.maxTokens }),
              errorKind: String(kind),
            });
            throw error;
          }
        };
      },
    });
  }

  /**
   * 取消后把章节状态归位到 ready。状态机不允许 reviewing/revising 直接到 ready，
   * 因此沿合法路径逐跳走回去（每跳都会留下审计事件，reason 一律「用户取消」）。
   */
  private static readonly CANCEL_PATHS: Partial<Record<ChapterWorkflowStatus["state"], ChapterWorkflowStatus["state"][]>> = {
    translating: ["ready"],
    reviewing: ["translating", "ready"],
    revising: ["translated", "translating", "ready"],
  };

  private async settleCancelledChapter(root: string, chapterId: string): Promise<void> {
    const store = new ChapterStateStore(root);
    const path = IpcService.CANCEL_PATHS[(await store.readChapter(chapterId)).state];
    if (!path) return;
    for (const next of path) {
      await store.transition(chapterId, next, { reason: "用户取消" });
    }
  }

  private async dispatch(envelope: IpcEnvelope): Promise<AnyResult> {
    switch (envelope.command) {
      case "workspace.open": return this.workspaces.openWorkspace(envelope.payload as IpcRequestMap["workspace.open"]);
      case "workspace.list": return this.workspaces.listWorkspaces();
      case "workspace.create": return this.workspaces.createWorkspace(envelope.payload as IpcRequestMap["workspace.create"]);
      case "workspace.close": return this.workspaces.closeWorkspace(envelope.payload as IpcRequestMap["workspace.close"]);
      case "workspace.forget": return this.workspaces.forgetWorkspace(envelope.payload as IpcRequestMap["workspace.forget"]);
      case "workspace.exportArchive": return this.workspaces.exportArchive(envelope.payload as IpcRequestMap["workspace.exportArchive"]);
      case "workspace.session.read": return this.workspaces.readWorkspaceSession();
      case "workspace.session.write": return this.workspaces.writeWorkspaceSession(envelope.payload as IpcRequestMap["workspace.session.write"]);
      case "workspace.renameVolume": return this.structure.renameVolume(envelope.payload as IpcRequestMap["workspace.renameVolume"]);
      case "workspace.renameChapter": return this.structure.renameChapter(envelope.payload as IpcRequestMap["workspace.renameChapter"]);
      case "import.preview": return this.workspaces.previewImport(envelope.payload as IpcRequestMap["import.preview"]);
      case "import.text": return this.workspaces.importText(envelope.payload as IpcRequestMap["import.text"]);
      case "import.run": return this.workspaces.importRun(envelope.payload as IpcRequestMap["import.run"]);
      case "chapter.create": return this.structure.createChapter(envelope.payload as IpcRequestMap["chapter.create"]);
      case "chapter.delete": return this.structure.deleteChapter(envelope.payload as IpcRequestMap["chapter.delete"]);
      case "chapter.restore": return this.structure.restoreChapter(envelope.payload as IpcRequestMap["chapter.restore"]);
      case "chapter.move": return this.structure.moveChapter(envelope.payload as IpcRequestMap["chapter.move"]);
      case "volume.delete": return this.structure.deleteVolume(envelope.payload as IpcRequestMap["volume.delete"]);
      case "volume.restore": return this.structure.restoreVolume(envelope.payload as IpcRequestMap["volume.restore"]);
      case "chapter.load": return this.chapterIo.loadChapter(envelope.payload as IpcRequestMap["chapter.load"]);
      case "chapter.saveDraft": return this.chapterIo.saveDraft(envelope.payload as IpcRequestMap["chapter.saveDraft"]);
      case "chapter.checkpoint": return this.chapterIo.checkpoint(envelope.payload as IpcRequestMap["chapter.checkpoint"]);
      case "chapter.loadSourceCorrection": return this.chapterIo.loadSourceCorrection(envelope.payload as IpcRequestMap["chapter.loadSourceCorrection"]);
      case "chapter.saveSourceCorrection": return this.chapterIo.saveSourceCorrection(envelope.payload as IpcRequestMap["chapter.saveSourceCorrection"]);
      case "translate.run": return this.workflow.translateRun(envelope.payload as IpcRequestMap["translate.run"]);
      case "translate.cancel": return this.cancelRun(envelope.payload as IpcRequestMap["translate.cancel"], (root, p) => translateRunKey(root, p.chapterId));
      case "translate.runScope": return this.workflow.translateRunScope(envelope.payload as IpcRequestMap["translate.runScope"]);
      case "translate.stopScope": return this.workflow.translateStopScope(envelope.payload as IpcRequestMap["translate.stopScope"]);
      case "review.run": return this.workflow.reviewRun(envelope.payload as IpcRequestMap["review.run"]);
      case "chapter.accept": return this.workflow.acceptChapter(envelope.payload as IpcRequestMap["chapter.accept"]);
      case "bookReview.run": return this.workflow.bookReviewRun(envelope.payload as IpcRequestMap["bookReview.run"]);
      case "bookReview.cancel": return this.cancelRun(envelope.payload as IpcRequestMap["bookReview.cancel"], (root) => bookReviewRunKey(root));
      case "bookReview.status": return this.workflow.bookReviewStatus(envelope.payload as IpcRequestMap["bookReview.status"]);
      case "confirm.list": return this.terminology.listConfirmations(envelope.payload as IpcRequestMap["confirm.list"]);
      case "confirm.decide": return this.terminology.confirmDecide(envelope.payload as IpcRequestMap["confirm.decide"]);
      case "terms.query": return this.terminology.queryTerms(envelope.payload as IpcRequestMap["terms.query"]);
      case "terms.create": return this.terminology.createTerm(envelope.payload as IpcRequestMap["terms.create"]);
      case "terms.update": return this.terminology.updateTerm(envelope.payload as IpcRequestMap["terms.update"]);
      case "terms.delete": return this.terminology.deleteTerm(envelope.payload as IpcRequestMap["terms.delete"]);
      case "terms.restore": return this.terminology.restoreTerm(envelope.payload as IpcRequestMap["terms.restore"]);
      case "rename.review": return this.terminology.listRenameReview(envelope.payload as IpcRequestMap["rename.review"]);
      case "rename.resolve": return this.terminology.resolveRenameReviewEntry(envelope.payload as IpcRequestMap["rename.resolve"]);
      case "export.run": return this.exports.exportRun(envelope.payload as IpcRequestMap["export.run"]);
      case "settings.read": return this.config.readSettings(envelope.payload as IpcRequestMap["settings.read"]);
      case "settings.write": return this.config.writeSettings(envelope.payload as IpcRequestMap["settings.write"]);
      case "ai.providers.list": return this.config.listAiProviders(envelope.payload as IpcRequestMap["ai.providers.list"]);
      case "ai.key.write": return this.config.writeAiKey(envelope.payload as IpcRequestMap["ai.key.write"]);
      case "ai.model.write": return this.config.writeAiModel(envelope.payload as IpcRequestMap["ai.model.write"]);
      case "ai.test": return this.config.testAi(envelope.payload as IpcRequestMap["ai.test"]);
      case "ai.provider.upsert": return this.config.upsertAiProvider(envelope.payload as IpcRequestMap["ai.provider.upsert"]);
      case "ai.provider.delete": return this.config.deleteAiProvider(envelope.payload as IpcRequestMap["ai.provider.delete"]);
      case "ai.model.upsert": return this.config.upsertAiModel(envelope.payload as IpcRequestMap["ai.model.upsert"]);
      case "ai.model.delete": return this.config.deleteAiModel(envelope.payload as IpcRequestMap["ai.model.delete"]);
      case "ai.provider.presets": return success(PRESET_PROVIDERS);
      case "ai.config.open": return this.config.openAiConfig(envelope.payload as IpcRequestMap["ai.config.open"]);
      case "ai.models.detect": return this.config.detectAiModels(envelope.payload as IpcRequestMap["ai.models.detect"]);
      case "ai.thinking.probe": return this.config.probeThinking(envelope.payload as IpcRequestMap["ai.thinking.probe"]);
      case "ai.key.open": return this.config.openAiKeyPage(envelope.payload as IpcRequestMap["ai.key.open"]);
      case "ai.thinking.write": return this.config.writeAiThinking(envelope.payload as IpcRequestMap["ai.thinking.write"]);
      case "ai.reviewThinking.write": return this.config.writeAiReviewThinking(envelope.payload as IpcRequestMap["ai.reviewThinking.write"]);
      case "ai.key.delete": return this.config.deleteAiKey(envelope.payload as IpcRequestMap["ai.key.delete"]);
      case "ai.oauth.login": return this.oauth.oauthLogin(envelope.payload as IpcRequestMap["ai.oauth.login"]);
      case "ai.oauth.wait": return this.oauth.oauthWait(envelope.payload as IpcRequestMap["ai.oauth.wait"]);
      case "ai.oauth.refresh": return this.oauth.oauthRefresh(envelope.payload as IpcRequestMap["ai.oauth.refresh"]);
      case "agent.log.list": return this.agentLogs.agentLogList(envelope.payload as IpcRequestMap["agent.log.list"]);
      case "usage.report": return this.agentLogs.usageReport(envelope.payload as IpcRequestMap["usage.report"]);
      case "agent.log.read": return this.agentLogs.agentLogRead(envelope.payload as IpcRequestMap["agent.log.read"]);
      case "dev.prompt.probe": return this.config.devPromptProbe(envelope.payload as IpcRequestMap["dev.prompt.probe"]);
      case "dialog.pickDirectory": return this.dialogs.pickDirectoryRequest(envelope.payload as IpcRequestMap["dialog.pickDirectory"]);
      case "dialog.pickFile": return this.dialogs.pickFileRequest();
    }
  }
}

export function createIpcService(options: IpcServiceOptions = {}): IpcService {
  return new IpcService(options);
}

