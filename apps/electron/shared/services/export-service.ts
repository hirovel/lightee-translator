/**
 * 导出服务。
 *
 * RV-07：两道门禁（只导出 approved 章节 / 整书导出需全书审校通过）已拆除。
 * 作者想导出不应受到任何阻碍——拿不到书的唯一原因只能是那部分**真的还没译**。
 * 代价是产物里可能混着未定稿的稿子，所以导出结果必须如实交代构成，让作者知道
 * 自己手里这份是什么；被跳过的章节绝不用原文占位。
 */
import { errorFor, failure, success, ServiceError, type AnyResult } from "../ipc-result.js";
import type { IpcRequestMap } from "../ipc-contract.js";
import type { ServiceContext } from "./service-context.js";
import type { WorkspaceRecord } from "../service-types.js";

export class ExportService {
  constructor(private readonly ctx: ServiceContext) {}

  private get engine() { return this.ctx.engine; }
  private workspace(workspaceId: string): WorkspaceRecord { return this.ctx.workspace(workspaceId); }
  private emitAgentStatus(...args: Parameters<ServiceContext["emitAgentStatus"]>): void { this.ctx.emitAgentStatus(...args); }

  async exportRun(request: IpcRequestMap["export.run"]): Promise<AnyResult> {
    if (!this.engine) return failure(errorFor("unsupported", "Engine wiring is unavailable", false));
    const workspace = this.workspace(request.workspaceId);
    // 多选导出没有单一「当前章节」可归属：只有真正的单章才带 chapterId，
    // 否则事件会被挂到勾选里的第一章上，看起来像只导了那一章。
    const targetLabel = Array.isArray(request.target)
      ? request.target.length === 1 ? request.target[0]! : `${request.target.length} 章`
      : request.target;
    const singleChapterId = Array.isArray(request.target)
      ? request.target.length === 1 ? request.target[0] : undefined
      : request.target === "all" ? undefined : request.target;
    const scopeFields = { workspaceId: request.workspaceId, ...(singleChapterId ? { chapterId: singleChapterId } : {}), operation: "export" as const };
    try {
      this.emitAgentStatus("export", "running", `${targetLabel} · ${request.format}`, scopeFields);
      const result = await this.engine.exportChapter({ root: workspace.root }, request.target, request.format, {
        ...(request.outDir === undefined ? {} : { outDir: request.outDir }),
        ...(request.fileName === undefined ? {} : { fileName: request.fileName }),
      });
      const note = result.skipped.length > 0 ? `${result.exported.length} 章 · 跳过 ${result.skipped.length} 章尚无译文` : `${result.exported.length} 章`;
      this.emitAgentStatus("export", "done", note, scopeFields);
      return success({
        status: "queued" as const,
        workspaceId: request.workspaceId,
        outPath: result.outPath,
        exported: result.exported,
        fromStaging: result.fromStaging,
        skipped: result.skipped,
      });
    } catch (cause) {
      this.emitAgentStatus("export", "failed", cause instanceof Error ? cause.message : "导出失败", scopeFields);
      throw new ServiceError(errorFor("internal", cause instanceof Error ? cause.message : "导出失败", false));
    }
  }

}
