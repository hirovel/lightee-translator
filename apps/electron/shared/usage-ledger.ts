/**
 * 工作区用量账本（EX-01）—— 每次 LLM 逻辑调用一行纯数字。
 *
 * ## 为什么不复用已有的两份记录
 *
 * 1. `~/.lightee/llm-history.jsonl`（`LlmRuntime.pushCallLog`）记的是**完整 prompt 与响应**，
 *    全局一份、按天几十 MB。它是 Agent 控制台的调试数据源，不是账本：算一本书花了多少钱
 *    不该要求先读进整本书的正文，而含正文的文件也不该被当作可随手分享的用量凭据。
 * 2. `LlmRuntime.getTokenTotals()` 只有跨调用累计值。总量回答「这一轮花了多少」，
 *    回答不了「哪一个阶段把钱花掉了」——4.87M 事故里正是这一点让归因拖了一整天。
 *
 * ## 红线：白名单，不是黑名单
 *
 * {@link usageLine} 只序列化本文件显式列出的字段。多传的字段一律**丢弃**而不是过滤——
 * 黑名单要求每次新增字段时有人记得去补，白名单不需要任何人记得。prompt、正文、密钥
 * 因此在结构上进不来，而不是靠调用点自觉。
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * 一次**网络尝试**的账本行（白名单即本接口的字段集）。
 *
 * ## 为什么从「一次逻辑调用一行」改成「一次尝试一行」
 *
 * EX-01 最初定的是一次逻辑调用一行、重试在内部消化，只留一个 attempts 计数。
 * 2026-08-12 的真实跑批证明这让账本变成假账：7 次逻辑调用背后是 27 次网络尝试，
 * 其中 20 次废掉的尝试各自烧了一整份 output，而账面上只有成功那次的数字。
 * 诊断时我只能靠手写脚本去刨含正文的 llm-history.jsonl——那正是账本该替人做的事。
 *
 * ## 判据：什么该进来
 *
 * 只进**能把「出了什么事」还原出来**的字段，且全是数字与短枚举。
 * `reasoningChars` / `textChars` 是这次诊断的关键——正是这一对（13447 : 174）
 * 才定位到「模型把预算全花在推理上、正文几乎为空」。记的是**长度不是内容**：
 * 长度足以判形态，而正文一个字都不该进账本。
 */
export interface UsageRecord {
  /** 本地毫秒时间戳。跨日对账按**供应商计费日时区**切窗，不是按这个值的日期（法证 C6） */
  ts: number;
  /** 一次跑批的关联键。没有它就无法把同一次运行的调用聚在一起看 */
  runId?: string;
  /** 归属标签 `<agent>:<stage>[:<unit>]`，如 `translate:ch012` */
  label: string;
  model: string;
  /** 本次尝试**实际生效**的思考档位 */
  thinking?: string;
  /** 调用方**请求**的档位。与 thinking 不同即说明发生了降档——这一栏缺失时，
   *  「用户选了 max」与「降到 low 才成」在账面上长得一样 */
  thinkingRequested?: string;
  /** 本行是这次逻辑调用的第几次尝试（1 起）。同一逻辑调用的多行靠它排序 */
  attempt?: number;
  /** 本次逻辑调用最终消耗的尝试总数（仅成功/终败那一行有） */
  attempts: number;
  ok: boolean;
  ms: number;
  ttftMs?: number;
  /** 未命中缓存的输入 token（已剔除 cacheRead/cacheWrite，与 pi-ai 同口径） */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 推理内容的**字符数**（不是内容）。与 textChars 一起判「预算花到哪去了」 */
  reasoningChars?: number;
  /** 正文的**字符数**（不是内容） */
  textChars?: number;
  /**
   * 服务商上报的**推理 token 数**（output 的子集，TR-11/TR-12）。
   * 有它就不必按字符估——字符估算是拿不到真值时的退路，不是默认做法。
   */
  reasoning?: number;
  /**
   * 服务商给的停止原因。
   *
   * **`length` 不等于「被截断」。** pi-ai 把 API 的 `status:"incomplete"` 一律映射成
   * `"length"`（openai-responses-shared.js:634），并不读 `incomplete_details.reason`。
   * 它只说明「没有正常结束」。要判是不是撞了预算，看 output 与 {@link maxTokens}。
   */
  stopReason?: string;
  /**
   * 服务商**原始**停止状态，未经 pi-ai 归一映射（TR-12）。短枚举
   * （completed/incomplete/stop/length/…），不含任何正文。`incomplete`
   * 才真正证明没正常结束——stopReason=length 只是所有 incomplete 的统一压缩。
   */
  rawStopReason?: string;
  /**
   * 本次尝试**发出去的**输出预算（未配置时缺席，不写默认值）。
   *
   * 2026-08-12 第二次跑批：四次失败的 output 是 16382/16382/16383/16385，
   * 而配置里的 maxTokens 正是 16384——碰上限的全失败、低于上限的全成功。
   * 当时账本没有这一栏，报告只能写「被服务商截断」，把我们自己设的天花板
   * 栽给了服务商。**记下当次的预算，才分得清触顶与服务商行为。**
   */
  maxTokens?: number;
  /** 失败原因的**分类**，不是原始消息——原始消息可能带回显的输入片段 */
  errorKind?: string;
}

export interface UsageTotals {
  calls: number;
  failed: number;
  attempts: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  ms: number;
}

/**
 * 一次运行的记账范围。`totals` 就地累加，运行结束后调用方读它生成摘要。
 *
 * 与 `cancellableLlm(llm, signal)` 同一个装配范式：能力由注入面套在桥上，
 * 业务代码只多一行。
 */
export interface UsageScope {
  readonly root: string;
  readonly label: string;
  readonly totals: UsageTotals;
}

export function usageScope(root: string, label: string): UsageScope {
  return { root, label, totals: { calls: 0, failed: 0, attempts: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ms: 0 } };
}

export function usageLedgerPath(root: string): string {
  return join(root, "sessions", "usage.jsonl");
}

const nonNegative = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);

/**
 * 账本行序列化。**逐字段挑选**，多余字段进不来（见文件头「红线」）。
 *
 * 标签同样要洗：它是代码常量拼章节 ID，理论上不该含换行，但 JSONL 的行边界
 * 依赖这一点，不能靠「理论上」。
 */
export function usageLine(record: UsageRecord): string {
  const row: UsageRecord = {
    ts: record.ts,
    label: String(record.label).replace(/[\r\n]+/g, " ").slice(0, 120),
    model: String(record.model).slice(0, 120),
    attempts: Math.max(1, nonNegative(record.attempts) || 1),
    ok: record.ok === true,
    ms: nonNegative(record.ms),
    input: nonNegative(record.input),
    output: nonNegative(record.output),
    cacheRead: nonNegative(record.cacheRead),
    cacheWrite: nonNegative(record.cacheWrite),
  };
  if (record.runId) row.runId = String(record.runId).replace(/[\r\n]+/g, " ").slice(0, 64);
  if (record.thinking) row.thinking = String(record.thinking).slice(0, 32);
  if (record.thinkingRequested) row.thinkingRequested = String(record.thinkingRequested).slice(0, 32);
  if (record.attempt !== undefined) row.attempt = Math.max(1, nonNegative(record.attempt) || 1);
  if (record.ttftMs !== undefined) row.ttftMs = nonNegative(record.ttftMs);
  if (record.reasoningChars !== undefined) row.reasoningChars = nonNegative(record.reasoningChars);
  if (record.textChars !== undefined) row.textChars = nonNegative(record.textChars);
  if (record.reasoning !== undefined) row.reasoning = nonNegative(record.reasoning);
  if (record.stopReason) row.stopReason = String(record.stopReason).replace(/[\r\n]+/g, " ").slice(0, 32);
  if (record.rawStopReason) row.rawStopReason = String(record.rawStopReason).replace(/[\r\n]+/g, " ").slice(0, 32);
  if (record.maxTokens !== undefined) row.maxTokens = nonNegative(record.maxTokens);
  if (record.errorKind) row.errorKind = String(record.errorKind).replace(/[\r\n]+/g, " ").slice(0, 60);
  return `${JSON.stringify(row)}\n`;
}

export function accumulate(totals: UsageTotals, record: UsageRecord): void {
  totals.calls += 1;
  if (!record.ok) totals.failed += 1;
  totals.attempts += Math.max(1, record.attempts || 1);
  totals.input += nonNegative(record.input);
  totals.output += nonNegative(record.output);
  totals.cacheRead += nonNegative(record.cacheRead);
  totals.cacheWrite += nonNegative(record.cacheWrite);
  totals.ms += nonNegative(record.ms);
}

/** 追加一行。**永不 reject**——账本写失败不该让翻译失败（与 AppLog.write 同一取舍） */
export async function appendUsage(root: string, record: UsageRecord): Promise<void> {
  const path = usageLedgerPath(root);
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, usageLine(record), "utf8");
  } catch {
    // 磁盘满 / 目录只读 / 路径非法：吞掉
  }
}

const compact = (value: number): string => (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value));

/**
 * 面向用户的一行摘要。**命中缓存单列**：命中与未命中的单价差一个数量级，
 * 合成一个「输入」数字会让人以为省了钱或没省钱，两种错都犯得起。
 */
export function summarizeUsage(totals: UsageTotals): string {
  if (totals.calls === 0) return "";
  const retries = totals.attempts - totals.calls;
  return [
    `${totals.calls} 次调用`,
    `输入 ${compact(totals.input)}${totals.cacheRead > 0 ? `（命中缓存 ${compact(totals.cacheRead)}）` : ""}`,
    `输出 ${compact(totals.output)}`,
    `${Math.round(totals.ms / 1000)}s`,
    ...(retries > 0 ? [`重试 ${retries} 次`] : []),
    ...(totals.failed > 0 ? [`失败 ${totals.failed} 次`] : []),
  ].join(" · ");
}
