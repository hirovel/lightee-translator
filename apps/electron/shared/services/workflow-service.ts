/**
 * 编排域服务（RH-11 / design/ipc-service-decomposition.md §2）。
 *
 * 归属：章节翻译（`translate.run`）、章节审校（`review.run`）、全书审校
 * （`bookReview.*`）三条长任务编排，以及它们共同依赖的全书审校状态机。
 *
 * 写权威：`reviews/**` 报告、`state/book-review.json`。章节正文与状态机的写入
 * 委托给引擎的 `chapterPipeline`——本服务只负责装配、取消与事件广播。
 *
 * 锁纪律（RH-15）：LLM 调用**不得**持有工作区锁。长任务期间工作区必须保持可读，
 * 否则用户在翻译进行中点开任意章节都会卡住（实测曾达 2051ms → 现 7ms）。
 */
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWriteFile, atomicWriteJson, readJson, readText, withFileMutationQueue } from "../atomic-file.js";
import { errorFor, failure, success, ServiceError, type AnyResult } from "../ipc-result.js";
import { CancelledError, isCancelledError } from "../cancellation.js";
import type { LlmBridge } from "../llm-types.js";
import { summarizeUsage, usageScope, type UsageScope } from "../usage-ledger.js";
import type {
  BookReviewStatusResult,
  IpcEventMap,
  IpcRequestMap,
  ParagraphDraft,
  ReviewReportSummary,
  RunScopeResult,
  TranslationWorkflowStatus,
} from "../ipc-contract.js";
import {
  ChapterStateStore,
  TerminologyRepository,
  readChapterParagraphs,
  resolveChapter,
  stagingTranslationPath,
  writeChapterParagraphs,
} from "@lightee/engine";
import type { ServiceContext } from "./service-context.js";
import type { BookReviewStateFile, WorkspacePipelineConfig, WorkspaceRecord } from "../service-types.js";
import { hasTranslatableBody } from "../source-body.js";

/** 可取消运行的键：一章一把，全书审校一把 */
export function translateRunKey(root: string, chapterId: string): string {
  return `${resolve(root)}:chapter:${chapterId}`;
}
export function bookReviewRunKey(root: string): string {
  return `${resolve(root)}:bookreview`;
}

interface ReviewReportFile extends ReviewReportSummary {
  chapterId: string;
  issues: Array<{ type: string; severity: string; location: string; found?: string; expected?: string; paragraphId?: string; paragraphIds?: string[]; termJa?: string; dialogueSafe?: boolean }>;
  history?: ReviewReportSummary[];
}

/**
 * 进行中的范围跑批（RS-1）。**只活在内存**（D9 续跑无状态）：崩溃后没有要恢复的
 * 「跑批计划」，重新发起时范围由章节状态即时查询重新给出。
 */
interface ScopeRunState {
  runId: string;
  total: number;
  /** 两段式停止的当前档位（D7）。boundary=翻完当前章即停；cancelled=立即取消 */
  stop: "none" | "boundary" | "cancelled";
  /** 第二击要取消的对象；章边界之间为 null */
  currentChapterId: string | null;
}

export class WorkflowService {
  constructor(private readonly ctx: ServiceContext) {}

  /** root（resolve 后）→ 跑批状态。一个工作区同时至多一个跑批 */
  private readonly scopeRuns = new Map<string, ScopeRunState>();

  // ===== 注入面转发（搬移过来的方法体保持零改动） =====
  private get engine(): ServiceContext["engine"] { return this.ctx.engine; }
  private get llm(): ServiceContext["llm"] { return this.ctx.llm; }
  private workspace(workspaceId: string) { return this.ctx.workspace(workspaceId); }
  private emit: ServiceContext["emit"] = (type, payload) => this.ctx.emit(type, payload);
  private emitAgentStatus: ServiceContext["emitAgentStatus"] = (agent, status, message, provenance) => this.ctx.emitAgentStatus(agent, status, message, provenance);
  private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> { return this.ctx.enqueue(key, fn); }
  private trackWrite<T>(promise: Promise<T>): Promise<T> { return this.ctx.trackWrite(promise); }
  private log: ServiceContext["log"] = (level, message) => this.ctx.log(level, message);
  private beginCancellable(runKey: string) { return this.ctx.beginCancellable(runKey); }
  private cancellableLlm(llm: LlmBridge, signal: AbortSignal): LlmBridge { return this.ctx.cancellableLlm(llm, signal); }
  private usageLlm(llm: LlmBridge, scope: UsageScope): LlmBridge { return this.ctx.usageLlm(llm, scope); }
  private thinkingLlm(llm: LlmBridge, provenance: { workspaceId?: string; chapterId?: string; runId?: string }): LlmBridge { return this.ctx.thinkingLlm(llm, provenance); }
  private settleCancelledChapter(root: string, chapterId: string): Promise<void> { return this.ctx.settleCancelledChapter(root, chapterId); }
  private workspaceIdForRoot(root: string): string | undefined { return this.ctx.workspaceIdForRoot(root); }
  /** 跨域读取只经注入面；这些 shim 让搬移过来的 `this.config.x` / `this.chapterIo.x` 保持原样 */
  private get config() {
    return {
      pipelineConfig: (root: string) => this.ctx.pipelineConfig(root),
      resolveReviewAgent: (root: string) => this.ctx.resolveReviewAgent(root),
    };
  }
  private get chapterIo() {
    return {
      readSourceCorrectionFile: (root: string, chapterId: string) => this.ctx.readSourceCorrectionFile(root, chapterId),
      sourceCorrectionPath: (root: string, chapterId: string) => this.ctx.sourceCorrectionPath(root, chapterId),
    };
  }
  // EX-07：术语状态注入随译前门禁一起退役——翻译不再问「术语确认到哪一步了」。

  async translateRun(request: IpcRequestMap["translate.run"]): Promise<AnyResult> {
    if (!this.engine) return failure(errorFor("unsupported", "Engine wiring is unavailable", false));
    const workspace = this.workspace(request.workspaceId);
    // EX-07 / ADR-0007：译前术语门禁退役——**导入即可翻**。
    //
    // 这道门禁原本要求「先跑完译前提取、再逐项确认、才准翻译」。融合式提取之后
    // 术语是随翻译逐章长出来的，译前那一趟已经不存在了；门禁留着就是拿一个不再运行的
    // 阶段挡住全部核心能力。术语确认改为**边翻边确认**：新词进队列，作者随时处理，
    // 改译法由 EX-06 追溯到已翻章节。

    // 空章节检测：无正文段落（仅标题/分隔/插图/空）→ 明确提示，不空翻译
    try {
      const resolved = await resolveChapter({ root: workspace.root }, request.chapterId);
      const sourceText = await readText(resolved.paths.source);
      if (!hasTranslatableBody(sourceText)) {
        return failure(errorFor("invalid_request", "该章节没有可翻译的正文内容", false));
      }
    } catch {
      return failure(errorFor("invalid_request", "未找到该章节的日文原文", false));
    }
    const key = `${workspace.root}:chapter:${request.chapterId}:workflow`;
    return this.trackWrite(this.enqueue(key, async () => {
      const runtime = this.llm ? null : this.engine!.createLlm();
      const base = this.llm ?? runtime!;
      // RH-16：整段运行挂在一个 AbortController 上，translate.cancel 通过它中止
      const cancellable = this.beginCancellable(translateRunKey(workspace.root, request.chapterId));
      // EX-01：记账在内、取消在外（装配顺序的理由见 IpcService.usageLlm）
      const usage = usageScope(workspace.root, `translate:${request.chapterId}`);
      // 装配顺序 取消 → 记账 → 思考直播：展示在最内层，看到的是真正发出去的那一次
      const llm = this.cancellableLlm(
        this.usageLlm(this.thinkingLlm(base, { workspaceId: request.workspaceId, chapterId: request.chapterId }), usage),
        cancellable.signal
      );
      const config = await this.config.pipelineConfig(workspace.root);
      const stateStore = new ChapterStateStore(workspace.root);
      // 熔断章节（stuck）：用户显式点「开始翻译」= 介入 → 重置重新出发
      const initialState = await stateStore.readChapter(request.chapterId);
      if (initialState.state === "stuck") {
        await stateStore.transition(request.chapterId, "translating", { reason: "用户重新发起翻译" });
        this.emitAgentStatus("translator", "running", `${request.chapterId} 重置后重新翻译`, { workspaceId: request.workspaceId, chapterId: request.chapterId, ...(initialState.runId ? { runId: initialState.runId } : {}), operation: "translate" });
      }
      let latestReport: ReviewReportFile | undefined;
      let reviewPass = 0;
      this.emit("translate.progress", { workspaceId: request.workspaceId, chapterId: request.chapterId, progress: 0, message: "开始翻译" });
      try {
        const result = await this.engine!.runChapterPipeline({ root: workspace.root }, request.chapterId, llm, config, {
          onWarn: (message) => this.emitAgentStatus("reviewer", "running", message, { workspaceId: request.workspaceId, chapterId: request.chapterId, operation: "review", kind: "warning" }),
          // 融合提取的降级挂在译者名下（EX-04 收尾）：告警亮哪盏灯必须与真正出问题的
          // 环节一致，否则作者按着「审校出问题了」去查，查的是另一个 Agent。
          onTranslateWarn: (message) => this.emitAgentStatus("translator", "running", message, { workspaceId: request.workspaceId, chapterId: request.chapterId, operation: "translate", kind: "warning" }),
          onReview: async (review) => {
            reviewPass += 1;
            latestReport = await this.persistReviewReport(workspace.root, review);
            this.emit("review.progress", { workspaceId: request.workspaceId, chapterId: request.chapterId, progress: 1, message: `${reviewPass > 1 ? `第 ${reviewPass} 轮复校 · ` : ""}${review.issueCount} 个问题` });
            this.emitAgentStatus("reviewer", "done", `${review.issueCount} 个问题`, { workspaceId: request.workspaceId, chapterId: request.chapterId, operation: "review" });
          },
          onStateChange: async (chapterId, from, to, detail, persistedState) => {
            const state = persistedState ?? await stateStore.readChapter(chapterId);
            // C-1：状态转移一行摘要。崩溃后靠它复原「章节走到哪一步」——不含任何正文。
            this.log("info", `chapter ${chapterId} ${from} -> ${to}${detail ? ` (${detail})` : ""}`);
            this.emit("chapter.stateChanged", {
              workspaceId: request.workspaceId,
              chapterId,
              from,
              to,
              reason: detail ?? `${from} -> ${to}`,
              runId: state.runId ?? "unknown",
              state,
            });
            if (to === "translating") {
              this.emit("translate.progress", { workspaceId: request.workspaceId, chapterId, progress: 0, message: detail ?? "开始翻译" });
              this.emitAgentStatus("translator", "running", chapterId, { workspaceId: request.workspaceId, chapterId, ...(state.runId ? { runId: state.runId } : {}), operation: "translate" });
            } else if (to === "reviewing") {
              this.emit("review.progress", { workspaceId: request.workspaceId, chapterId, progress: 0, message: detail ?? "开始审校" });
              this.emitAgentStatus("reviewer", "running", chapterId, { workspaceId: request.workspaceId, chapterId, ...(state.runId ? { runId: state.runId } : {}), operation: "review" });
            } else if (to === "approved" || to === "stuck") {
              this.emitAgentStatus("reviewer", "done", detail ?? to, { workspaceId: request.workspaceId, chapterId, ...(state.runId ? { runId: state.runId } : {}), operation: "review" });
            }
          },
        });
        // 取消可能被管线的修复阶梯吞掉（LLM 抛错 → 重试 → 最终 stuck 正常返回），
        // 所以成功路径也必须检查 abort，否则「已取消」会伪装成「翻译熔断」。
        if (cancellable.signal.aborted) throw new CancelledError();
        const workflow = await stateStore.readChapter(request.chapterId);
        // P2-4：翻译失败（gate 两次失败等）后状态回 ready + lastError → 视为 stuck（待人工/重试），不误报“审校完成”
        const workflowStatus = workflow.state === "approved" ? "approved" as const : workflow.state === "stuck" || (workflow.state === "ready" && Boolean(workflow.lastError)) ? "stuck" as const : "needs-review" as const;
        const reviewValue = result.review && latestReport
          ? {
            chapterId: result.review.chapterId,
            issueCount: result.review.issueCount,
            issues: result.review.issues.map((issue) => ({
              type: issue.type,
              severity: issue.severity,
              location: issue.location,
              found: issue.found,
              expected: issue.expected,
              message: `${issue.type}${issue.found ? `：${issue.found}` : ""}`,
              suggestion: issue.expected,
            })),
            reportId: latestReport.reportId,
            generatedAt: latestReport.generatedAt,
            history: latestReport.history,
          }
          : undefined;
        // EX-01：完成消息带本章用量摘要。挂钟与花费此前只有跑完对着服务商账单才看得见，
        // 而账单是全天合计的——对不到任何一章。
        const spent = summarizeUsage(usage.totals);
        const outcome = workflowStatus === "approved" ? "翻译与审校完成" : workflowStatus === "stuck" ? (workflow.state === "ready" ? "翻译失败，请检查后重试" : "审校熔断，待人工决策") : "翻译已产出，待后续处理";
        this.log("info", `chapter ${request.chapterId} ${workflowStatus} ${spent || "无 LLM 调用"}`);
        this.emit("translate.progress", { workspaceId: request.workspaceId, chapterId: request.chapterId, progress: 1, message: spent ? `${outcome} · ${spent}` : outcome });
        if (workflowStatus === "approved") {
          // 重新翻译成功 → 清除源文需重译标记
          await this.clearRequiresRetranslation(workspace.root, request.chapterId);
          // BQ-06：章节重新翻译 → 全书 AI 基线失效（作者自由编辑不受限）
          await this.markBookReviewStale(workspace.root, `章节 ${request.chapterId} 重新翻译`);
        }
        await this.queueTranslatorTerms(workspace.root, request.workspaceId, request.chapterId);
        return success({ chapterId: request.chapterId, charCount: result.charCount, workflowStatus, workflow, ...(reviewValue ? { review: reviewValue } : {}) });
      } catch (cause) {
        // RH-16：取消不是失败——状态归位到 ready，返回可判定的 conflict（不可重试），
        // 作者可以立刻重新发起翻译。
        if (cancellable.signal.aborted || isCancelledError(cause)) {
          await this.settleCancelledChapter(workspace.root, request.chapterId);
          this.emitAgentStatus("translator", "failed", "已取消", { workspaceId: request.workspaceId, chapterId: request.chapterId, operation: "translate" });
          this.emit("translate.progress", { workspaceId: request.workspaceId, chapterId: request.chapterId, progress: 0, message: "已取消" });
          return failure(errorFor("conflict", "翻译已取消", false, { cancelled: true }));
        }
        this.emitAgentStatus("translator", "failed", cause instanceof Error ? cause.message : "翻译失败", { workspaceId: request.workspaceId, chapterId: request.chapterId, operation: "translate" });
        throw new ServiceError(errorFor("internal", cause instanceof Error ? cause.message : "翻译失败", true));
      } finally {
        cancellable.end();
      }
    }));
  }

  // ===== 范围跑批（RS-1 / TP-RS 批 D6-D9、D13）=====

  /**
   * 串行跑批引擎。渲染层只发**意图清单**；每章开工前这里再校验一次状态（D6），
   * 不再需要翻的跳过并在事件流出声。每章的执行体就是 {@link translateRun}——
   * 取消、记账、思考直播、状态机全部复用，跑批只是编排层。
   *
   * **串行不是省事，是正确性**：EX-05 的累积词表要求第 N 章的注入块是第 N-1 章的
   * 前缀追加，并行会破坏这个序（ADR-0008 依赖它保证跨章一致）。
   */
  async translateRunScope(request: IpcRequestMap["translate.runScope"]): Promise<AnyResult> {
    if (!this.engine) return failure(errorFor("unsupported", "Engine wiring is unavailable", false));
    const workspace = this.workspace(request.workspaceId);
    const rootKey = resolve(workspace.root);
    if (this.scopeRuns.has(rootKey)) {
      return failure(errorFor("conflict", "已有工作在进行中，请先停止或等待完成", false));
    }
    // 去重保序：同一章在清单里出现两次是渲染层 bug，跑两遍只有损失
    const seen = new Set<string>();
    const chapters = request.chapters.filter((c) => !seen.has(c.chapterId) && (seen.add(c.chapterId), true));
    const runId = `scope_${Date.now().toString(36)}`;
    const state: ScopeRunState = { runId, total: chapters.length, stop: "none", currentChapterId: null };
    this.scopeRuns.set(rootKey, state);
    const summary: RunScopeResult = {
      runId, total: chapters.length,
      approved: [], needsReview: [], stuck: [], skipped: [], failed: [], remaining: [],
      stopped: "none", pendingTerms: 0,
    };
    const emitScope = (phase: IpcEventMap["translate.scopeChanged"]["phase"], extra: Partial<IpcEventMap["translate.scopeChanged"]> = {}) =>
      this.emit("translate.scopeChanged", { workspaceId: request.workspaceId, runId, total: chapters.length, phase, ...extra });
    emitScope("started");
    this.emitAgentStatus("translator", "running", `开始工作：${chapters.length} 章`, { workspaceId: request.workspaceId, runId, operation: "translate" });
    this.log("info", `runScope ${runId} start: ${chapters.length} chapters`);
    // state.stop 在每个 await 期间都可能被 translateStopScope（另一次 IPC 调用）改写。
    // TS 的属性窄化不建模这种并发赋值，会把 await 之后的再读误判为恒 "none"——
    // 经函数读取绕开窄化，同时把「这个值随时会变」写在名字上。
    const currentStop = (): ScopeRunState["stop"] => state.stop;
    try {
      for (let i = 0; i < chapters.length; i += 1) {
        const { chapterId, retranslate } = chapters[i]!;
        if (currentStop() !== "none") {
          summary.remaining.push(...chapters.slice(i).map((c) => c.chapterId));
          break;
        }
        // D6：清单是意图不是命令。点勾选框到这一章开工之间可能隔了几个小时，
        // 期间单章翻译、删除章节都可能发生——按**现在**的状态裁定，跳过要出声。
        const skipReason = await this.revalidateScopeChapter(workspace.root, chapterId, retranslate === true);
        if (skipReason) {
          summary.skipped.push({ chapterId, reason: skipReason });
          emitScope("chapter-skipped", { index: i + 1, chapterId, reason: skipReason });
          this.log("info", `runScope ${runId} skip ${chapterId}: ${skipReason}`);
          continue;
        }
        state.currentChapterId = chapterId;
        emitScope("chapter-started", { index: i + 1, chapterId });
        // translateRun 对内部错误是 **throw** ServiceError（单章场景由 invoke 顶层接住）；
        // 跑批不接住的话，一章抽风就带走整批——恰好违背 D8。
        let result: AnyResult;
        try {
          result = await this.translateRun({ workspaceId: request.workspaceId, chapterId });
        } catch (cause) {
          result = failure(cause instanceof ServiceError
            ? cause.ipcError
            : errorFor("internal", cause instanceof Error ? cause.message : "翻译失败", true));
        }
        state.currentChapterId = null;
        if (!result.ok) {
          const details = result.error.details as { cancelled?: boolean } | undefined;
          if (currentStop() === "cancelled" || details?.cancelled === true) {
            // 单章取消（translate.cancel）也终结整个跑批：用户按下取消后批次立刻
            // 开下一章，等于取消键打地鼠——任何一种取消都视为「停下来」。
            state.stop = "cancelled";
            summary.remaining.push(...chapters.slice(i).map((c) => c.chapterId));
            break;
          }
          // D8：无人值守是跑批的存在理由——失败记账，继续下一章
          summary.failed.push({ chapterId, reason: result.error.message });
          emitScope("chapter-done", { index: i + 1, chapterId, reason: `failed:${result.error.code}` });
          continue;
        }
        const status = (result.value as { workflowStatus: TranslationWorkflowStatus }).workflowStatus;
        if (status === "approved") summary.approved.push(chapterId);
        else if (status === "stuck") summary.stuck.push(chapterId);
        else summary.needsReview.push(chapterId);
        emitScope("chapter-done", { index: i + 1, chapterId, reason: status });
      }
      summary.stopped = state.stop;
      summary.pendingTerms = await this.countPendingTerms(workspace.root);
      emitScope("finished", { stop: summary.stopped, summary });
      const line = `完成 ${summary.approved.length} · 卡住 ${summary.stuck.length + summary.failed.length} · 待审术语 ${summary.pendingTerms}`;
      this.emitAgentStatus("translator", "done", `工作结束：${line}`, { workspaceId: request.workspaceId, runId, operation: "translate" });
      this.log("info", `runScope ${runId} finished approved=${summary.approved.length} needsReview=${summary.needsReview.length} stuck=${summary.stuck.length} skipped=${summary.skipped.length} failed=${summary.failed.length} remaining=${summary.remaining.length} stopped=${summary.stopped}`);
      // D13：结束通知只在多章跑批发——单章的完成本来就在眼前，通知只是打扰
      if (chapters.length > 1) {
        this.ctx.notify({
          title: summary.stopped === "none" ? "工作完成" : "工作已停止",
          body: line,
          onClick: () => emitScope("notification-clicked"),
        });
      }
      return success(summary);
    } finally {
      this.scopeRuns.delete(rootKey);
    }
  }

  /** 开工前复核（D6）。返回 null=可以开工；返回字符串=跳过理由 */
  private async revalidateScopeChapter(root: string, chapterId: string, retranslate: boolean): Promise<string | null> {
    try {
      const resolved = await resolveChapter({ root }, chapterId);
      const sourceText = await readText(resolved.paths.source);
      if (!hasTranslatableBody(sourceText)) return "没有可翻译的正文";
    } catch {
      return "章节不存在（可能已被删除）";
    }
    const chapterState = (await new ChapterStateStore(root).readChapter(chapterId)).state;
    // D4：已译章在清单里 = 作者勾选时就看见它已译（显式重译），不跳。
    // 这里挡的是**跑批途中**才完成的章——勾选时它还没译，重译不是作者的意图。
    if (chapterState === "approved" && !retranslate) return "开工前复核：本章已在本次工作之外完成";
    if (chapterState === "translating" || chapterState === "reviewing") return `本章正被其他任务处理（${chapterState}）`;
    return null;
  }

  /** 待终审术语数（D13 通知的第三个数）：档案暂定（provenance=model）+ 传统确认卡 */
  private async countPendingTerms(root: string): Promise<number> {
    try {
      const snapshot = await new TerminologyRepository(root).readSnapshot();
      const provisional = [...snapshot.archives.names, ...snapshot.archives.terms]
        .filter((entry) => (entry as { provenance?: string }).provenance === "model").length;
      const status = await this.ctx.readEffectiveTerminologyStatus(root);
      return provisional + status.pendingCount;
    } catch {
      return 0;
    }
  }

  /**
   * 两段式停止（D7）。第一击=章边界停（当前章翻完落盘后不再开新章）；
   * 第二击=立即取消（走单章取消那条路，状态由 settleCancelledChapter 收敛）。
   * 已在 cancelled 档再点保持幂等。
   */
  async translateStopScope(request: IpcRequestMap["translate.stopScope"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    const state = this.scopeRuns.get(resolve(workspace.root));
    if (!state) return success({ status: "idle" as const });
    const emitStop = () => this.emit("translate.scopeChanged", {
      workspaceId: request.workspaceId, runId: state.runId, total: state.total,
      phase: "stop-requested", stop: state.stop,
      ...(state.currentChapterId ? { chapterId: state.currentChapterId } : {}),
    });
    if (state.stop === "none") {
      state.stop = "boundary";
      emitStop();
      this.log("info", `runScope ${state.runId} boundary stop requested`);
      return success({ status: "boundary" as const });
    }
    state.stop = "cancelled";
    if (state.currentChapterId) this.ctx.requestCancel(translateRunKey(workspace.root, state.currentChapterId));
    emitStop();
    this.log("info", `runScope ${state.runId} immediate cancel requested`);
    return success({ status: "cancelling" as const });
  }

  /** 关窗排空（RH-04）：跑批断在章边界，正在飞的那一章立即取消 */
  stopScopeRunsForShutdown(): void {
    for (const [root, state] of this.scopeRuns) {
      state.stop = "cancelled";
      if (state.currentChapterId) this.ctx.requestCancel(translateRunKey(root, state.currentChapterId));
    }
  }

  private async persistReviewReport(root: string, result: { chapterId: string; issueCount: number; issues: Array<{ type: string; severity: string; location: string; found?: string; expected?: string; paragraphId?: string; paragraphIds?: string[]; termJa?: string; dialogueSafe?: boolean }> }): Promise<ReviewReportFile> {
    const report: ReviewReportFile = {
      reportId: `rev_${Date.now().toString(36)}`,
      chapterId: result.chapterId,
      generatedAt: new Date().toISOString(),
      issueCount: result.issueCount,
      issues: result.issues,
    };
    await atomicWriteJson(join(root, "reviews", `${result.chapterId}.${report.reportId}.json`), report);
    await atomicWriteJson(join(root, "reviews", `${result.chapterId}.current.json`), report);
    const history = await this.reviewHistory(root, result.chapterId);
    return { ...report, history };
  }

  private async reviewHistory(root: string, chapterId: string): Promise<ReviewReportSummary[]> {
    const prefix = `${chapterId}.rev_`;
    const names = await readdir(join(root, "reviews")).catch(() => [] as string[]);
    const reports = await Promise.all(names
      .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
      .map((name) => readJson<ReviewReportFile | null>(join(root, "reviews", name), null)));
    return reports
      .filter((report): report is ReviewReportFile => Boolean(report?.reportId && report.generatedAt))
      .map(({ reportId, generatedAt, issueCount }) => ({ reportId, generatedAt, issueCount }))
      .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));
  }

  /**
   * 作者复核后显式接受本章（R5-1）——L4 人工确认层在章节工作流上的落点。
   *
   * 解除两类死锁：
   * 1. `stuck`：机械检查是确定性的，一个合法但被判为异常的段落重译多少次都会再次触发，
   *    然后原路回到 stuck。46 章里只要卡住一章，全书审校与导出就永远凑不齐条件。
   * 2. `imported` 且无可翻译正文（封面 / 版权 / 纯插图页）：这类章节压根不该翻译，
   *    却同样被「全部章节 approved」的门禁算作未完成。
   *
   * 其余状态一律拒绝：接受一个还没翻的普通章节没有任何意义，
   * 放行只会让「approved」这个词失去含义。
   */
  async acceptChapter(request: IpcRequestMap["chapter.accept"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    const key = `${workspace.root}:chapter:${request.chapterId}:workflow`;
    return this.trackWrite(this.enqueue(key, async () => {
      const store = new ChapterStateStore(workspace.root);
      const current = await store.ensureChapter(request.chapterId);
      if (current.state === "approved") {
        return success({ workspaceId: request.workspaceId, chapterId: request.chapterId, state: current.state, reason: "本章已是通过状态" });
      }
      if (current.state !== "stuck") {
        // 只放行 stuck。没翻过的章节「接受」没有任何意义，而封面/版权这类无正文页
        // 该由用户删掉而不是标记完成——蒙混过关的结果是导出里夹着一页日文。
        const hint = current.state === "imported"
          ? "本章尚未翻译。若这是封面/版权等无正文页，请删除该章节。"
          : `当前状态 ${current.state} 不支持直接接受`;
        return failure(errorFor("conflict", hint, false, { state: current.state }));
      }
      const reason = "作者复核后接受本章（跳过未解决的审校问题）";
      const from = current.state;
      // 先把暂存译文提升为正式译文，再落状态。
      // 只改状态不提升的话，「approved」就是张空头支票：md/epub 导出读的是
      // translations/{id}_zh.md，而 stuck 章节的译文一直只躺在 state/staging 里，
      // 于是导出报「Missing translation for chapter ch001」。
      const staging = stagingTranslationPath(workspace.root, request.chapterId);
      if (existsSync(staging)) {
        const target = join(workspace.root, "translations", `${request.chapterId}_zh.md`);
        await atomicWriteFile(target, await readText(staging));
      }
      await store.transition(request.chapterId, "approved", { reason, authorAccepted: true });
      const next = await store.readChapter(request.chapterId);
      this.log("info", `chapter ${request.chapterId} ${from} -> approved (${reason})`);
      this.emit("chapter.stateChanged", {
        workspaceId: request.workspaceId,
        chapterId: request.chapterId,
        from,
        to: "approved",
        reason,
        runId: next.runId ?? "author-accept",
        state: next,
      });
      // 作者放行一章 = 全书基线变了，已通过的全书审校必须重跑
      await this.markBookReviewStale(workspace.root, `作者接受章节 ${request.chapterId}`);
      return success({ workspaceId: request.workspaceId, chapterId: request.chapterId, state: next.state, reason });
    }));
  }

  async reviewRun(request: IpcRequestMap["review.run"]): Promise<AnyResult> {
    if (!this.engine) return failure(errorFor("unsupported", "Engine wiring is unavailable", false));
    const workspace = this.workspace(request.workspaceId);
    const key = `${workspace.root}:chapter:${request.chapterId}:workflow`;
    return this.trackWrite(this.enqueue(key, async () => {
      this.emit("review.progress", { workspaceId: request.workspaceId, chapterId: request.chapterId, progress: 0, message: "开始审校" });
      this.emitAgentStatus("reviewer", "running", request.chapterId, { workspaceId: request.workspaceId, chapterId: request.chapterId, operation: "review" });
      try {
      const runtime = this.llm ? null : this.engine!.createLlm();
      const usage = usageScope(workspace.root, `review:${request.chapterId}`);
      const llm = this.usageLlm(
        this.thinkingLlm(this.llm ?? runtime!, { workspaceId: request.workspaceId, chapterId: request.chapterId }),
        usage
      );
      const result = await this.engine!.reviewChapter({ root: workspace.root }, request.chapterId, {
        // 规则轮失败不阻塞审校，但引擎侧的告警必须有人听——不接这个回调，
        // 「自定义规则这一项没查成」在真实应用里就无声无息（与 terminology 的 onWarn 同一模式）。
        onWarn: (message) => this.emitAgentStatus("reviewer", "running", message, { workspaceId: request.workspaceId, chapterId: request.chapterId, operation: "review", kind: "warning" }),
      });
      // RV-01：没东西可查就别落一份「0 个问题」的报告——那份报告日后会被当成
      // 「查过了，干净」的凭据。此时也不该刷新历史。
      if (result.noTranslation) {
        this.emit("review.progress", { workspaceId: request.workspaceId, chapterId: request.chapterId, progress: 1, message: "本章还没有可审校的译文" });
        this.emitAgentStatus("reviewer", "done", "本章还没有可审校的译文", { workspaceId: request.workspaceId, chapterId: request.chapterId, operation: "review" });
        return success({ chapterId: result.chapterId, issueCount: 0, issues: [], checksRun: [], noTranslation: true });
      }
      const report = await this.persistReviewReport(workspace.root, result);
      this.emit("review.progress", { workspaceId: request.workspaceId, chapterId: request.chapterId, progress: 1, message: `${result.issueCount} 个问题` });
      this.emitAgentStatus("reviewer", "done", `${result.issueCount} 个问题`, { workspaceId: request.workspaceId, chapterId: request.chapterId, operation: "review" });
      return success({
        chapterId: result.chapterId,
        issueCount: result.issueCount,
        issues: result.issues.map((issue) => ({
          type: issue.type,
          severity: issue.severity,
          location: issue.location,
          found: issue.found,
          expected: issue.expected,
          message: `${issue.type}${issue.found ? `：${issue.found}` : ""}`,
          suggestion: issue.expected,
          ...(issue.paragraphId ? { paragraphId: issue.paragraphId } : {}),
          ...(issue.paragraphIds?.length ? { paragraphIds: issue.paragraphIds } : {}),
          ...(issue.termJa ? { termJa: issue.termJa } : {}),
          ...(issue.dialogueSafe !== undefined ? { dialogueSafe: issue.dialogueSafe } : {}),
        })),
        ...(result.checksRun ? { checksRun: result.checksRun } : {}),
        reportId: report.reportId,
        generatedAt: report.generatedAt,
        history: report.history,
      });
      } catch (cause) {
        this.emitAgentStatus("reviewer", "failed", cause instanceof Error ? cause.message : "审校失败", { workspaceId: request.workspaceId, chapterId: request.chapterId, operation: "review" });
        throw new ServiceError(errorFor("internal", cause instanceof Error ? cause.message : "审校失败", true));
      }
    }));
  }

  // ===== 全书/整卷两级批准（BQ-06）=====
  async readBookReviewState(root: string): Promise<BookReviewStateFile> {
    const f = await readJson<BookReviewStateFile | null>(join(root, "state", "book-review.json"), null);
    return f && f.status ? f : { status: "none", updatedAt: Date.now() };
  }

  private bookReviewStatePath(root: string): string {
    return join(root, "state", "book-review.json");
  }

  private async writeBookReviewState(root: string, file: BookReviewStateFile): Promise<void> {
    await atomicWriteJson(this.bookReviewStatePath(root), file satisfies BookReviewStateFile);
    const workspaceId = this.workspaceIdForRoot(root);
    if (workspaceId) {
      this.emit("bookReview.changed", {
        workspaceId,
        status: file.status,
        reason: file.staleReason,
        updatedAt: file.updatedAt,
      });
    }
  }

  /**
   * book-review.json 的唯一读-改-写临界区（ADR-0005）。
   * 该文件被多条不同队列的路径修改（settings 写入、术语提交、导入、翻译、审校决策），
   * 只有文件级队列能保证它们互斥。回调返回 null 表示不写。
   */
  private async mutateBookReviewState(root: string, fn: (current: BookReviewStateFile) => BookReviewStateFile | null | Promise<BookReviewStateFile | null>): Promise<void> {
    await withFileMutationQueue(this.bookReviewStatePath(root), async () => {
      const next = await fn(await this.readBookReviewState(root));
      if (next) await this.writeBookReviewState(root, next);
    });
  }

  /** 输入变化（译文/术语/源文）→ 已通过的全书审校失效 */
  /**
   * 译者在翻译途中标注的新术语进入确认队列。
   *
   * EX-07 之后这是**唯一**的确认卡来源：译前提取阶段退役，术语随翻译逐章到达。
   * 不入队就只是躺在 state/pending-terms.json 里，用户看不见。队列变化由术语仓库的
   * 状态事件广播，界面上的待确认计数随之更新。
   *
   * 入队失败不影响译文，因此只记日志不上抛——但也不静默：候选仍留在待办文件里，下次翻译再试。
   */
  private async queueTranslatorTerms(root: string, workspaceId: string, chapterId: string): Promise<void> {
    if (!this.engine?.promotePendingTerms) return;
    try {
      const { added } = await this.engine.promotePendingTerms({ root });
      if (added === 0) return;
      this.log("info", `chapter ${chapterId} queued ${added} translator-marked terms`);
      this.emitAgentStatus("terminologist", "done", `译者标注 ${added} 项新术语待确认`, { workspaceId, chapterId, operation: "terminology" });
    } catch (cause) {
      this.log("warn", `queue translator terms failed for ${chapterId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  /**
   * 底稿变了 → 现有建议基于旧版本（RV-06）。
   * 状态仍是 advisory：建议还在、还能看、还能跳转，只是加一句「基于旧版本」的注记。
   * 从前这里会把状态推成 stale，而 stale 是导出门禁的拒绝理由之一。
   */
  async markBookReviewStale(root: string, reason: string): Promise<void> {
    await this.mutateBookReviewState(root, (s) =>
      s.status === "advisory" ? { ...s, staleReason: reason, updatedAt: Date.now() } : null);
  }

  /** 需要重新翻译的章节（源文 semantic 修改尚未重译） */
  private async chaptersRequiringRetranslation(root: string): Promise<string[]> {
    const manifest = await readJson<{ chapters?: Array<{ id: string }> }>(join(root, "source", "manifest.json"), {});
    const ids = (manifest.chapters ?? []).map((c) => c.id);
    const dirty: string[] = [];
    for (const id of ids) {
      const c = await this.chapterIo.readSourceCorrectionFile(root, id);
      if (c?.requiresRetranslation) dirty.push(id);
    }
    return dirty;
  }

  /** 作者在全文审校后手动修改过译文 → 记录非阻塞提示（不 stale、不阻塞导出） */
  async markBookReviewAuthorEdited(root: string): Promise<void> {
    await this.mutateBookReviewState(root, (s) =>
      s.status === "advisory" ? { ...s, authorEditedSinceReview: true, updatedAt: Date.now() } : null);
  }

  /**
   * 作者修改译文 → 同步段落权威（保留 type/source；baseRevision 用段落 revision 防覆盖）。
   *
   * R3-2：**内容真的变了**的段落打上 human 标记，之后整章重译与局部修订都不再覆盖它。
   * 只按「这次保存包含了这一段」来打标是不行的——编辑器每次保存都提交全章段落，
   * 那样一次无改动的保存就会把整章冻成人工段，自动修订从此全废。
   */
  async syncParagraphsFromDraft(root: string, chapterId: string, drafts: ParagraphDraft[]): Promise<void> {
    const existing = await readChapterParagraphs({ root }, chapterId);
    if (!existing) return; // 无段落权威（旧数据章节）→ 不创建
    const byId = new Map(drafts.map((d) => [d.id, d]));
    const merged = existing.paragraphs.map((p) => {
      const draft = byId.get(p.id);
      if (!draft) return p;
      const edited = draft.translation !== p.translation;
      return {
        ...p,
        translation: draft.translation,
        source: draft.source,
        ...(edited ? { translatedBy: "human" as const } : {}),
      };
    });
    await writeChapterParagraphs({ root }, chapterId, merged, { baseRevision: existing.revision, staging: false });
  }

  /** 重新翻译成功 → 清除源文需重译标记（写回 correction） */
  private async clearRequiresRetranslation(root: string, chapterId: string): Promise<void> {
    const path = this.chapterIo.sourceCorrectionPath(root, chapterId);
    await withFileMutationQueue(path, async () => {
      const c = await this.chapterIo.readSourceCorrectionFile(root, chapterId);
      if (!c?.requiresRetranslation) return;
      await atomicWriteJson(path, { ...c, requiresRetranslation: false, savedAt: Date.now() });
    });
  }

  // RV-06：highChaptersOf / retranslateForBookReview 已删除——全书审校不再自动改写任何章节。


  /** 报告里的一条建议 → 送给界面的形状（RV-06：一个字段都不裁） */
  private toAdvice(i: {
    chapterIds?: string[]; chapterId?: string; type: string; severity: string; paragraphIds?: string[];
    found?: string; expected?: string; repairInstruction?: string;
    evidenceRefs?: Array<{ source: string; context: string }>;
  }): NonNullable<BookReviewStatusResult["issues"]>[number] {
    return {
      chapterIds: i.chapterIds ?? (i.chapterId ? [i.chapterId] : []),
      type: i.type,
      severity: i.severity,
      ...(i.paragraphIds ? { paragraphIds: i.paragraphIds } : {}),
      ...(i.found ? { found: i.found } : {}),
      ...(i.expected ? { expected: i.expected } : {}),
      ...(i.repairInstruction ? { repairInstruction: i.repairInstruction } : {}),
      ...(i.evidenceRefs?.length ? { evidenceRefs: i.evidenceRefs } : {}),
    };
  }

  private async bookReviewStatusResult(
    root: string,
    s: BookReviewStateFile,
    /** 刚跑完时手里就有报告，直接用——不必赌一次回读能成功 */
    inMemory?: { summary?: BookReviewStatusResult["summary"]; issues?: Array<Parameters<WorkflowService["toAdvice"]>[0]> },
  ): Promise<BookReviewStatusResult> {
    const result: BookReviewStatusResult = {
      status: s.status, runId: s.runId, reportPath: s.reportPath, scope: s.scope,
      staleReason: s.staleReason, authorEditedSinceReview: s.authorEditedSinceReview,
      lastError: s.lastError, skippedChapters: s.skippedChapters,
    };
    // RV-06：明细必须原样送到界面。此前这里只留 4 个字段，
    // 「建议怎么改」被裁在服务层，作者一条都没见过。
    if (inMemory) {
      result.summary = inMemory.summary;
      result.issues = inMemory.issues?.map((i) => this.toAdvice(i));
      return result;
    }
    if (s.reportPath && existsSync(s.reportPath)) {
      try {
        const report = JSON.parse(readFileSync(s.reportPath, "utf8")) as {
          summary?: BookReviewStatusResult["summary"];
          issues?: Array<Parameters<WorkflowService["toAdvice"]>[0]>;
        };
        result.summary = report.summary;
        result.issues = report.issues?.map((i) => this.toAdvice(i));
      } catch {
        // 报告损坏 → 只给状态
      }
    }
    return result;
  }

  async bookReviewStatus(request: IpcRequestMap["bookReview.status"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    const s = await this.readBookReviewState(workspace.root);
    // P2-2：running 残留（上次运行中断）→ 回到「没跑过」并说明原因。
    // 中断没有留下报告，把它画成一个特殊状态只会让人以为还有什么可看的。
    if (s.status === "running" && Date.now() - s.updatedAt > 60 * 60 * 1000) {
      return success(await this.bookReviewStatusResult(workspace.root, {
        ...s, status: "none" as const, lastError: "上次通读中断了，可以重新运行", updatedAt: Date.now(),
      }));
    }
    return success(await this.bookReviewStatusResult(workspace.root, s));
  }

  async bookReviewRun(request: IpcRequestMap["bookReview.run"]): Promise<AnyResult> {
    if (!this.engine?.runBookReview) return failure(errorFor("unsupported", "Engine wiring is unavailable", false));
    const workspace = this.workspace(request.workspaceId);
    const manifest = JSON.parse(await readText(join(workspace.root, "source", "manifest.json"))) as { chapters?: Array<{ id: string }> };
    const chapterIds = (manifest.chapters ?? []).map((c) => c.id);
    if (chapterIds.length === 0) return failure(errorFor("conflict", "工作区没有章节", false));
    // RV-06：两道前置门禁（必须全部 approved / 源文修改过的必须先重译）已拆除。
    // 通读是作者主动问的一句意见，不该等到全书完工才允许问。没有译文的章节看不了，
    // 那就如实说明跳过了哪几章——少看几章而不告知，才是真正的问题。
    const withoutTranslation: string[] = [];
    for (const id of chapterIds) {
      const hasParagraphs = existsSync(join(workspace.root, "state", "paragraphs", `${id}.json`));
      const hasTranslation = existsSync(join(workspace.root, "translations", `${id}_zh.md`));
      if (!hasParagraphs && !hasTranslation) withoutTranslation.push(id);
    }
    if (withoutTranslation.length === chapterIds.length) {
      return failure(errorFor("conflict", "还没有任何章节有译文，通读无从谈起", false, { chapters: withoutTranslation }));
    }
    // 没译文的章节**排除出扫描范围**，不是只在事后报一句「跳过了」。
    // 从前不传 scope，engine 就按全书目录跑，把 translation 为空串的章节一并送进模型：
    // 花钱读了个寂寞，还会回一堆「整段未译」的废建议——而状态里却写着这些章被跳过了，
    // 说的和做的对不上。范围以真正有译文的章节为准。
    const reviewScope = chapterIds.filter((id) => !withoutTranslation.includes(id));
    const key = `${workspace.root}:bookreview`;
    return this.trackWrite(this.enqueue(key, async () => {
      const runtime = this.llm ? null : this.engine!.createLlm();
      const cancellable = this.beginCancellable(bookReviewRunKey(workspace.root));
      const usage = usageScope(workspace.root, "book-review");
      const llm = this.cancellableLlm(
        this.usageLlm(this.thinkingLlm(this.llm ?? runtime!, { workspaceId: request.workspaceId }), usage),
        cancellable.signal
      );
      const { model: bookReviewModel, thinking: bookReviewThinking } = await this.config.resolveReviewAgent(workspace.root);
      const bookReviewLlm = {
        complete: async (system: string, user: string) => {
          // 全文审校按 system 内容区分 L2 窗口 / Reduce 汇总（按调用传标签，不再改共享属性）
          const label = system.includes("汇总") ? "book-review:reduce" : "book-review:l2-shard";
          const res = await llm.complete(bookReviewModel, [{ role: "system", content: system }, { role: "user", content: user }], { thinking: bookReviewThinking, label });
          return res.text;
        },
      };
      this.emit("bookReview.progress", { workspaceId: request.workspaceId, status: "running", message: "开始全文审校" });
      this.emitAgentStatus("reviewer", "running", "全书一致性审校", { workspaceId: request.workspaceId, operation: "bookReview" });
      // P2-2：运行状态持久化（崩溃后可见 running 残留；超时按 blocked 提示）
      await this.mutateBookReviewState(workspace.root, (s) => ({ ...s, status: "running", staleReason: undefined, updatedAt: Date.now() }));
      try {
        // 作者审校规则（settings review.rules）：只取 enabled 的，注入通读窗口。
        // 读失败按「没有规则」处理——规则是增强项，不该挡住通读本身。
        const authorRules = await (async () => {
          try {
            const raw = JSON.parse(await readText(join(workspace.root, "config.json"))) as {
              review?: { rules?: Array<{ name?: unknown; rule?: unknown; enabled?: unknown }> };
            };
            return (raw.review?.rules ?? [])
              .filter((rule) => rule && rule.enabled !== false && typeof rule.name === "string" && typeof rule.rule === "string")
              .map((rule) => ({ name: rule.name as string, rule: rule.rule as string }));
          } catch { return []; }
        })();
        const runReviewOnce = () => this.engine!.runBookReview!({ root: workspace.root }, {
          llm: bookReviewLlm,
          scope: reviewScope,
          ...(authorRules.length > 0 ? { authorRules } : {}),
          onProgress: async (_phase: string, message: string, done: number, total: number) => {
            this.emit("bookReview.progress", { workspaceId: request.workspaceId, status: "running", message, progress: done / Math.max(1, total) });
          },
        });
        // RV-06：自动修订闭环（发现 high → 逐章重译 → 重跑）已删除。
        // 一个 L2 判断不该有权改写作者的译文；建议就只是建议，改不改是作者的事。
        const result = await runReviewOnce();
        const adviceCount = result.report.issues?.length ?? 0;
        const state: BookReviewStateFile = {
          status: "advisory",
          runId: result.runId,
          reportPath: result.reportPath,
          scope: result.report.scope,
          reviewedAt: Date.now(),
          authorEditedSinceReview: false,
          staleReason: undefined,
          lastError: undefined,
          ...(withoutTranslation.length > 0 ? { skippedChapters: withoutTranslation } : {}),
          updatedAt: Date.now(),
        };
        await this.writeBookReviewState(workspace.root, state);
        const done = adviceCount > 0 ? `通读完成，${adviceCount} 条建议` : "通读完成，没有发现问题";
        this.emit("bookReview.progress", { workspaceId: request.workspaceId, status: state.status, message: done });
        this.emitAgentStatus("reviewer", "done", done, { workspaceId: request.workspaceId, operation: "bookReview" });
        return success(await this.bookReviewStatusResult(workspace.root, state, result.report));
      } catch (cause) {
        // RH-16：取消不是错误。RV-06：取消与失败都回到「没跑过」——两种情况都没留下报告，
        // 差别只在要不要留一句原因。
        if (cancellable.signal.aborted || isCancelledError(cause)) {
          await this.mutateBookReviewState(workspace.root, (s) => ({ ...s, status: "none", staleReason: undefined, lastError: undefined, updatedAt: Date.now() }));
          this.emit("bookReview.progress", { workspaceId: request.workspaceId, status: "none", message: "已取消" });
          this.emitAgentStatus("reviewer", "failed", "已取消", { workspaceId: request.workspaceId, operation: "bookReview" });
          return failure(errorFor("conflict", "全文审校已取消", false, { cancelled: true }));
        }
        const reason = cause instanceof Error ? cause.message : "全文审校失败";
        await this.writeBookReviewState(workspace.root, { status: "none", lastError: reason, updatedAt: Date.now() });
        this.emitAgentStatus("reviewer", "failed", reason, { workspaceId: request.workspaceId, operation: "bookReview" });
        throw new ServiceError(errorFor("internal", reason, true));
      } finally {
        cancellable.end();
      }
    }));
  }

  // RV-06：bookReviewDecide 已删除。「接受为全书通过」预设了一个可以否决作者的判断，
  // 而全书审校降级为建议之后，没有需要作者去接受的否决了。

}
