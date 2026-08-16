/**
 * Agent 调用日志服务（RH-11 从 `ipc-service.ts` 搬出，零行为变更）。
 * 完整 prompt/response 只在内存环形缓冲里，不落盘、不进持久日志（脱敏红线）。
 */
import { readFile } from "node:fs/promises";
import { errorFor, failure, success, type AnyResult } from "../ipc-result.js";
import type { IpcRequestMap } from "../ipc-contract.js";
import type { LlmCallLogEntry } from "../llm-types.js";
import type { ServiceContext } from "./service-context.js";
import { usageLedgerPath, type UsageRecord } from "../usage-ledger.js";
import { buildUsageReport, groupUsageByLabel } from "../usage-report.js";

/**
 * 按 id 回查历史时读多少行。列表默认只要 30 条，但作者可能点开的是很早以前那一次——
 * 回查的范围必须比列表宽，否则「列表里看得见、点开却说找不到」。
 */
const HISTORY_LOOKUP_LIMIT = 2000;

export class AgentLogService {
  constructor(private readonly ctx: ServiceContext) {}

  private get llm() { return this.ctx.llm; }
  private get isDev() { return this.ctx.isDev; }

  /**
   * 用量去向：读工作区账本，给出总报告 + 按标签分组。
   *
   * 与跑批脚本共用 `buildUsageReport` / `groupUsageByLabel` 这一份口径——
   * 界面上看到的和命令行跑批印出来的必须是同一套结论，否则两边一旦对不上，
   * 人就不知道该信哪个。
   *
   * 账本行本身就是白名单产物（只有数字与短枚举），这里原样转发，正文进不来。
   */
  async usageReport(request: IpcRequestMap["usage.report"]): Promise<AnyResult> {
    try {
      const workspace = this.ctx.workspace(request.workspaceId);
      if (!workspace) return failure(errorFor("not_found", "工作区未打开", false));
      const raw = await readFile(usageLedgerPath(workspace.root), "utf8").catch(() => "");
      const rows: UsageRecord[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line) as UsageRecord); } catch { /* 坏行跳过：一行坏掉不该让整张表打不开 */ }
      }
      return success({ report: buildUsageReport(rows), groups: groupUsageByLabel(rows) });
    } catch (error) {
      return failure(errorFor("internal", error instanceof Error ? error.message : String(error), false));
    }
  }

  /**
   * 调用列表 = 内存环形缓冲 **并上** 持久化历史（按 id 去重，新→旧）。
   *
   * 从前只问内存缓冲（上限 50，重启即空），于是重启后作者看到的是一张空表，
   * 以为「上次的记录都没了」——其实 `~/.lightee/llm-history.jsonl` 里一条没丢，
   * 只是没人去读。历史读失败按「只有内存那部分」处理：查不到旧记录不该让整张表打不开。
   */
  private async mergedCallLog(limit: number, workspaceId?: string): Promise<LlmCallLogEntry[]> {
    // 按书过滤时把读取窗口放宽：先取 limit 条再过滤会让别的书的记录把配额吃光，
    // 这本书明明有记录、列表却是空的。
    const window = workspaceId ? Math.max(limit, HISTORY_LOOKUP_LIMIT) : limit;
    const memory = this.llm?.getCallLog?.(window) ?? [];
    const history = await (this.llm?.getHistory?.(window) ?? Promise.resolve([])).catch(() => [] as LlmCallLogEntry[]);
    const byId = new Map(history.map((entry) => [entry.id, entry]));
    // 内存条目覆盖同 id 的历史条目：同一次调用两处都有时，以进程内那份为准
    for (const entry of memory) byId.set(entry.id, entry);
    const merged = [...byId.values()];
    // 严格按戳过滤：没有戳的旧记录无法归属到任何一本书，不放进任何书的视图里——
    // 「可能是这本书的」混进来，比列表短一点更糟。
    const scoped = workspaceId ? merged.filter((entry) => entry.workspaceId === workspaceId) : merged;
    return scoped.sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  async agentLogList(request: IpcRequestMap["agent.log.list"]): Promise<AnyResult> {
    const entries = (await this.mergedCallLog(request.limit ?? 30, request.workspaceId)).map((entry) => ({
      id: entry.id,
      label: entry.label,
      model: entry.model,
      thinking: entry.thinking,
      ok: entry.ok,
      promptPreview: entry.prompt.slice(0, 200),
      responsePreview: entry.response.slice(0, 260),
      // 工具轮的 response 是空串。不给计数的话，它在列表里与「模型什么都没回」无从区分。
      ...(entry.toolCalls?.length ? { toolCallCount: entry.toolCalls.length } : {}),
      ms: entry.ms,
      ts: entry.ts,
      error: entry.error,
      // R0-2：逐条 usage。总量只说得清「这一轮花了多少」，说不清「哪一次打穿了前缀」。
      usage: entry.usage,
    }));
    const totals = this.llm?.getTokenTotals?.() ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    return success({ entries, dev: this.isDev, totals });
  }
  async agentLogRead(request: IpcRequestMap["agent.log.read"]): Promise<AnyResult> {
    // 内存缓冲优先（同一次调用两处都有时以进程内为准），落空再翻持久化历史——
    // 重启前那些调用的 prompt/response 都还在文件里，没有理由说「找不到」。
    const entry = this.llm?.getCallLogById?.(request.id)
      ?? (await (this.llm?.getHistory?.(HISTORY_LOOKUP_LIMIT) ?? Promise.resolve([] as LlmCallLogEntry[])).catch(() => [] as LlmCallLogEntry[]))
        .find((candidate) => candidate.id === request.id);
    if (!entry) return failure(errorFor("not_found", "没有该调用记录", false));
    return success({
      id: entry.id,
      label: entry.label,
      model: entry.model,
      thinking: entry.thinking,
      ok: entry.ok,
      prompt: entry.prompt,
      response: entry.response,
      reasoning: entry.reasoning,
      // 工具通道的两半：`tools` 是发出去的指令（KA-5 之后它一个字都不在 prompt 里），
      // `toolCalls` 是模型的产出（工具轮的 response 是空串）。少任何一个，
      // 控制台呈现的都是「什么都没说、什么都没答」——而那是假的。
      tools: entry.tools,
      toolCalls: entry.toolCalls,
      ms: entry.ms,
      ts: entry.ts,
      error: entry.error,
      usage: entry.usage,
    });
  }
}
