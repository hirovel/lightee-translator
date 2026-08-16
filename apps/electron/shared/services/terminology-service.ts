/**
 * 术语域服务（RH-11 / design/ipc-service-decomposition.md §2）。
 *
 * 归属：术语准备（`terminology.prepare`）、确认会话（`confirm.*`）、术语表读写
 * （`terms.*`）以及外部仓库变更的轮询与事件广播。
 *
 * 写权威：`terminology/**`、`state/cards.json`、`state/confirm-session.json`、
 * `state/terminology-status.json`。跨进程一致性由 `withTerminologyWorkspaceLock` 保证。
 *
 * 观察者（watcher）只在真正打开的工作区上运行——RH-20 实测：为注册表里每个 ready
 * 工作区都起一个轮询，10 本书时空闲即吃掉约一个核心的 88%。
 */
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { atomicWriteJson, readJson } from "../atomic-file.js";
import { errorFor, failure, success, type AnyResult } from "../ipc-result.js";
import type {
  IpcError,
  IpcRequestMap,
  IpcResult,
  JsonValue,
  TermArchive,
  TermMutationResult,
  TermQueryFilters,
  TermRecord,
  TerminologyChangeAction,
  TerminologyStatus,
  TerminologyStatusSnapshot,
  TermQueryResult,
  RenameReviewResult,
} from "../ipc-contract.js";
import {
  SEEDED_POST_DICT_RULES,
  TerminologyRepository,
  TerminologyRepositoryError,
  readRenameReview,
  resolveRenameReview,
  retroRename,
  withTerminologyWorkspaceLock,
  type TerminologyCommit,
  type TerminologySnapshot,
} from "@lightee/engine";
import type { ServiceContext } from "./service-context.js";
import { summarizeUsage, usageScope } from "../usage-ledger.js";
import type { WorkspaceRecord } from "../service-types.js";

type TerminologyStatusFile = TerminologyStatusSnapshot;

const TERMINOLOGY_ARCHIVES: readonly { archive: TermArchive; file: string }[] = [
  { archive: "names", file: "names.json" },
  { archive: "terms", file: "terms.json" },
  { archive: "voice", file: "voice.json" },
  { archive: "onomatopoeia", file: "onomatopoeia.json" },
  { archive: "puns", file: "puns.json" },
  { archive: "preDict", file: "pre-dict.json" },
  { archive: "postDict", file: "post-dict.json" },
  { archive: "noTranslate", file: "no-translate.json" },
];
const SAFE_TERM_ID = /^[A-Za-z0-9._:-]+$/;
/** 作者字典档案：存储用 find/replace，展示与编辑复用术语面的 ja/zh 两列 */
const DICT_ARCHIVES: readonly TermArchive[] = ["preDict", "postDict"];

function safeJson(value: unknown): JsonValue {
  return (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" || Array.isArray(value) || typeof value === "object")
    ? value as JsonValue
    : null;
}

function uniqueTermId(base: string, used: Set<string>): string {
  let id = base;
  let suffix = 2;
  while (used.has(id)) id = `${base}-${suffix++}`;
  used.add(id);
  return id;
}

function initialTerminologyStatus(): TerminologyStatusSnapshot {
  return {
    status: "not-extracted",
    cardCount: 0,
    pendingCount: 0,
    confirmedCount: 0,
    updatedAt: null,
    extractionId: null,
  };
}

export class TerminologyService {
  private readonly terminologyRepositories = new Map<string, TerminologyRepository>();
  private readonly terminologyWatchers = new Map<string, NodeJS.Timeout>();
  private readonly terminologySeenCommits = new Map<string, Set<string>>();
  private readonly terminologyRevisions = new Map<string, number>();

  constructor(private readonly ctx: ServiceContext, private readonly enableTerminologyWatcher: boolean) {}

  // ===== 注入面转发（搬移过来的方法体保持零改动） =====
  private get engine(): ServiceContext["engine"] { return this.ctx.engine; }
  private get llm(): ServiceContext["llm"] { return this.ctx.llm; }
  private get config(): { pipelineConfig: ServiceContext["pipelineConfig"] } { return { pipelineConfig: (root: string) => this.ctx.pipelineConfig(root) }; }
  private workspace(workspaceId: string) { return this.ctx.workspace(workspaceId); }
  private emit: ServiceContext["emit"] = (type, payload) => this.ctx.emit(type, payload);
  private emitAgentStatus: ServiceContext["emitAgentStatus"] = (agent, status, message, provenance) => this.ctx.emitAgentStatus(agent, status, message, provenance);
  private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> { return this.ctx.enqueue(key, fn); }
  private trackWrite<T>(promise: Promise<T>): Promise<T> { return this.ctx.trackWrite(promise); }
  private markBookReviewStale(root: string, reason: string): Promise<void> { return this.ctx.markBookReviewStale(root, reason); }
  private log: ServiceContext["log"] = (level, message) => this.ctx.log(level, message);

  /** 运行中的轮询数量（测试钩子；RH-20 的回归断言依赖它） */
  watcherCount(): number {
    return this.terminologyWatchers.size;
  }

  /** 关窗排水：停掉全部轮询，避免定时器阻止进程退出（RH-08） */
  stopAllWatchers(): void {
    for (const root of this.terminologyWatchers.keys()) this.stopTerminologyWatcher(root);
  }

  terminologyRepository(root: string): TerminologyRepository {
    const key = resolve(root);
    const existing = this.terminologyRepositories.get(key);
    if (existing) return existing;
    const repository = new TerminologyRepository(key);
    this.terminologyRepositories.set(key, repository);
    return repository;
  }

  private seenTerminologyCommits(root: string): Set<string> {
    const key = resolve(root);
    const existing = this.terminologySeenCommits.get(key);
    if (existing) return existing;
    const seen = new Set<string>();
    this.terminologySeenCommits.set(key, seen);
    return seen;
  }

  async emitTerminologyCommit(workspace: WorkspaceRecord, commit: TerminologyCommit): Promise<void> {
    const root = resolve(workspace.root);
    const seen = this.seenTerminologyCommits(root);
    if (seen.has(commit.commitId)) return;
    seen.add(commit.commitId);
    this.terminologyRevisions.set(root, Math.max(this.terminologyRevisions.get(root) ?? 0, commit.revision));
    const status = await this.readTerminologyStatus(root);
    this.emit("terminology.changed", {
      workspaceId: workspace.info.id,
      ...status,
      revision: commit.revision,
      commitId: commit.commitId,
      archives: commit.archives,
      action: commit.action,
    });
    if (commit.archives.length > 0) {
      const action: "created" | "updated" | "deleted" | "restored" = commit.action === "created" ? "created" : commit.action === "deleted" ? "deleted" : commit.action === "restored" ? "restored" : "updated";
      this.emit("terms.changed", { workspaceId: workspace.info.id, revision: commit.revision, action });
    }
  }

  private async emitTerminologyStatus(workspace: WorkspaceRecord): Promise<TerminologySnapshot> {
    const snapshot = await this.terminologyRepository(workspace.root).readSnapshot();
    this.terminologyRevisions.set(resolve(workspace.root), snapshot.revision);
    const status = await this.readTerminologyStatus(workspace.root);
    this.emit("terminology.changed", {
      workspaceId: workspace.info.id,
      ...status,
      revision: snapshot.revision,
      commitId: `status:${randomUUID()}`,
      archives: [],
      action: "status",
    });
    return snapshot;
  }

  startTerminologyWatcher(workspace: WorkspaceRecord): void {
    if (!this.enableTerminologyWatcher) return;
    const root = resolve(workspace.root);
    if (this.terminologyWatchers.has(root)) return;
    // 轮询经 trackWrite 登记：它会写 terminology-status.json，属于关窗必须排空的写。
    // 只 clearInterval 不等待在飞的这一次，等于「停了表还在写」——表现是关窗后仍有落盘，
    // 测试里则是 rm 删到一半被重建出的文件顶回来（ENOTEMPTY）。
    const timer = setInterval(() => { void this.ctx.trackWrite(this.pollTerminologyEvents(workspace)); }, 250);
    timer.unref?.();
    this.terminologyWatchers.set(root, timer);
    // Delay the first reconciliation so workspace creation can finish writing its initial files.
    // The poll reads both the event log and canonical snapshot, so commits made during the delay are recovered.
  }

  stopTerminologyWatcher(root: string): void {
    const key = resolve(root);
    const timer = this.terminologyWatchers.get(key);
    if (timer) clearInterval(timer);
    this.terminologyWatchers.delete(key);
    this.terminologyRevisions.delete(key);
    this.terminologySeenCommits.delete(key);
  }

  private async pollTerminologyEvents(workspace: WorkspaceRecord): Promise<void> {
    const root = resolve(workspace.root);
    if (!this.terminologyWatchers.has(root)) return;
    try {
      const repository = this.terminologyRepository(root);
      const knownRevision = this.terminologyRevisions.get(root) ?? 0;
      const events = await repository.readEvents();
      for (const event of events) {
        if (event.revision > knownRevision || (event.action === "status" && event.revision === knownRevision)) {
          await this.emitTerminologyCommit(workspace, event);
        }
      }
      const snapshot = await repository.readSnapshot();
      const currentRevision = this.terminologyRevisions.get(root) ?? 0;
      if (snapshot.revision > currentRevision && snapshot.lastCommit) {
        // 按 lastCommit 本来的动作发，不再改标成 recovered（与 emitRepositoryChanges 的兜底一致）。
        // 仓库的提交顺序是「先写快照、再追加事件」，两次写之间有一个窗口：这一轮读事件时
        // 还没有这条、读快照时已经有了。旧代码把落在窗口里的**正常提交**一律标成 recovered
        // （含义是「事件日志丢了、从快照修回来的」），而窗口宽窄只取决于磁盘快慢——本地过、
        // CI 的 windows runner 上随机翻车。
        // 而且事后也分不出来：readSnapshot 自己会把缺的事件补回日志，所以「真丢过」和
        // 「只是没赶上追加」在再读一次时长得一模一样。分不出的标签就不该发。
        await this.emitTerminologyCommit(workspace, snapshot.lastCommit);
      }
    } catch {
      // The next poll/reopen will reconcile from the canonical snapshot.
    }
  }

  private async emitRepositoryChanges(workspace: WorkspaceRecord, previousRevision: number): Promise<TerminologySnapshot> {
    const repository = this.terminologyRepository(workspace.root);
    const events = await repository.readEvents();
    let emitted = false;
    for (const event of events) {
      if (event.revision > previousRevision || (event.action === "status" && event.revision === previousRevision)) {
        await this.emitTerminologyCommit(workspace, event);
        emitted = true;
      }
    }
    const snapshot = await repository.readSnapshot();
    if (!emitted && snapshot.lastCommit && (snapshot.revision > previousRevision || !this.seenTerminologyCommits(resolve(workspace.root)).has(snapshot.lastCommit.commitId))) {
      await this.emitTerminologyCommit(workspace, snapshot.lastCommit);
      emitted = true;
    }
    if (!emitted) await this.emitTerminologyStatus(workspace);
    return snapshot;
  }

  repositoryError(cause: unknown): IpcError | null {
    if (!(cause instanceof TerminologyRepositoryError)) return null;
    const code: IpcError["code"] = cause.code === "busy" ? "busy" : cause.code === "not_found" ? "not_found" : cause.code === "conflict" ? "conflict" : "invalid_request";
    return errorFor(code, cause.message, cause.code === "busy", cause.details as JsonValue | undefined);
  }

  async readTerminologyStatus(root: string): Promise<TerminologyStatusSnapshot> {
    try {
      const raw = await readJson<unknown>(join(root, "state", "terminology-status.json"), null);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return initialTerminologyStatus();
      const value = raw as Record<string, unknown>;
      const status = value.status === "pending" || value.status === "confirmed" || value.status === "not-extracted" ? value.status : "not-extracted";
      return {
        status,
        cardCount: typeof value.cardCount === "number" && Number.isSafeInteger(value.cardCount) && value.cardCount >= 0 ? value.cardCount : 0,
        pendingCount: typeof value.pendingCount === "number" && Number.isSafeInteger(value.pendingCount) && value.pendingCount >= 0 ? value.pendingCount : 0,
        confirmedCount: typeof value.confirmedCount === "number" && Number.isSafeInteger(value.confirmedCount) && value.confirmedCount >= 0 ? value.confirmedCount : 0,
        updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : null,
        extractionId: typeof value.extractionId === "string" ? value.extractionId : null,
      };
    } catch {
      return initialTerminologyStatus();
    }
  }

  async readEffectiveTerminologyStatus(root: string): Promise<TerminologyStatusSnapshot> {
    const storedStatus = await this.readTerminologyStatus(root);
    if (storedStatus.status !== "pending") return storedStatus;
    const session = await readJson<Record<string, unknown> | null>(join(root, "state", "confirm-session.json"), null);
    if (!session || !Array.isArray(session.cards)) return storedStatus;
    const cardCount = session.cards.length;
    const rawIndex = typeof session.index === "number" && Number.isSafeInteger(session.index) ? session.index : 0;
    const confirmedCount = Math.min(Math.max(0, rawIndex), cardCount);
    return { ...storedStatus, cardCount, confirmedCount, pendingCount: cardCount - confirmedCount };
  }

  /**
   * 导入了新原文 → 术语状态失效（2026-08-10）。
   *
   * `terminology-status.json` 是**工作区级**标志，而 `translateRun` 的前置门禁就是
   * `status !== "confirmed"`。不失效的话，扫描确认过一次之后导入的任何章节都能绕过
   * 术语门禁——门禁存在的全部意义就是「本章候选术语必须先确认」。
   *
   * 只改「是否扫描过」，**不动 `terminology/*.json` 里用户确认的成果**；重扫时
   * `prepareTerminology` 会跳过已确认的词，只问新章节里的新词。
   */
  async markTerminologyStale(root: string, reason: string): Promise<void> {
    const current = await this.readTerminologyStatus(root);
    if (current.status === "not-extracted") return;
    await this.writeTerminologyStatus(root, { ...current, status: "not-extracted", pendingCount: 0, confirmedCount: 0, updatedAt: Date.now() });
    this.log("info", `terminology marked stale: ${reason}`);
    // 复用既有的状态广播（payload 字段齐全）：renderer 收到 terminology.changed 会同时
    // 刷新徽标、footer 主按钮与侧栏术语表——三处都得跟着改，缺一处就又是「显示不真实」。
    const workspaceId = this.ctx.workspaceIdForRoot(root);
    if (workspaceId) await this.emitTerminologyStatus(this.workspace(workspaceId));
  }

  private async writeTerminologyStatus(root: string, status: TerminologyStatusSnapshot): Promise<void> {
    await atomicWriteJson(join(root, "state", "terminology-status.json"), status satisfies TerminologyStatusFile);
  }

  // EX-07 / ADR-0007：译前提取入口（prepareTerminologyForWorkspace / terminology.prepare）在此退役。
  //
  // 它扫描全书、生成候选卡、要求作者逐项确认，翻译才准开工。融合式提取之后术语随翻译
  // 逐章长出来（EX-04），确认队列由译者发现的新词填充（promotePendingTerms）——
  // 同一个 confirm.* 会话机制照旧，只是**入口从「开工前跑一趟」变成「边翻边到达」**。

  async confirmDecide(request: IpcRequestMap["confirm.decide"]): Promise<AnyResult> {
    if (!this.engine) return failure(errorFor("unsupported", "Engine wiring is unavailable", false));
    const workspace = this.workspace(request.workspaceId);
    const key = `${workspace.root}:terminology`;
    return this.trackWrite(this.enqueue(key, async () => {
      const beforeRevision = (await this.terminologyRepository(workspace.root).readSnapshot()).revision;
      const session = await this.engine!.confirm.loadSession({ root: workspace.root });
      if (!session) return failure(errorFor("not_found", "没有待确认的术语会话", false));
      if (request.expectedIndex !== undefined && request.expectedIndex !== session.index) {
        return failure(errorFor("conflict", `确认进度已变更，当前是第 ${session.index + 1} 项`, false, { currentIndex: session.index, expectedIndex: request.expectedIndex }));
      }
      if (request.action === "quit") {
        const status = await this.readTerminologyStatus(workspace.root);
        return success({ index: session.index, total: session.cards.length, applied: 0, status: status.status, revision: beforeRevision });
      }
      if (request.action === "back") {
        if (session.index > 0) {
          session.index -= 1;
          session.verdicts = session.verdicts.slice(0, -1);
          await this.engine!.confirm.saveSession({ root: workspace.root }, session);
        }
      } else {
        if (session.index >= session.cards.length) return failure(errorFor("not_found", "确认会话已结束", false));
        const action = request.action === "accept"
          ? { action: "accept" as const, chosenZh: request.chosenZh, chosenCharacter: request.chosenCharacter }
          : request.action === "modify"
            ? { action: "modify" as const, chosenZh: request.chosenZh ?? "", chosenCharacter: request.chosenCharacter }
            : { action: "skip" as const };
        await this.engine!.confirm.verdict({ root: workspace.root }, session, action);
      }
      let applied = 0;
      let status: TerminologyStatus = "pending";
      if (session.index >= session.cards.length && request.action !== "back") {
        const confirmedAt = Date.now();
        const confirmedStatus: TerminologyStatusSnapshot = {
          status: "confirmed",
          cardCount: session.cards.length,
          pendingCount: 0,
          confirmedCount: session.cards.length,
          updatedAt: confirmedAt,
          extractionId: (await this.readTerminologyStatus(workspace.root)).extractionId,
        };
        const entries = await this.engine!.confirm.finishSession({ root: workspace.root }, session, {
          afterCommit: async () => { await this.writeTerminologyStatus(workspace.root, confirmedStatus); },
        });
        applied = entries.length;
        status = "confirmed";
      }
      const terminology = await this.emitRepositoryChanges(workspace, beforeRevision);
      return success({ index: session.index, total: session.cards.length, applied, status, revision: terminology.revision });
    }));
  }

  async listConfirmations(request: IpcRequestMap["confirm.list"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    const key = `${workspace.root}:terminology`;
    return this.enqueue(key, async () => withTerminologyWorkspaceLock(workspace.root, async () => {
      const cards = await readJson<unknown[]>(join(workspace.root, "state", "cards.json"), []);
      const session = await readJson<unknown | null>(join(workspace.root, "state", "confirm-session.json"), null);
      const status = await this.readEffectiveTerminologyStatus(workspace.root);
      const revision = (await this.terminologyRepository(workspace.root).readSnapshotInTransaction()).revision;
      return success({ cards: cards.map(safeJson), session: safeJson(session), status, revision });
    }));
  }

  async readTerminologyArchives(root: string, includeDeleted = false): Promise<{ items: TermRecord[]; revision: number }> {
    const snapshot = await this.terminologyRepository(root).readSnapshot();
    const byArchive = new Map<TermArchive, TermRecord[]>();
    const terms = snapshot.archives.terms;
    const termRows: TermRecord[] = terms.map((value) => ({
      ...value,
      id: String(value.id ?? "terms:entry"),
      ...(typeof value.id === "string" ? { entryId: value.id } : {}),
      ja: String(value.ja ?? ""),
      zh: String(value.zh ?? ""),
      archive: "terms" as const,
      archiveFile: "terms.json",
      sourceId: typeof value.sourceId === "string" ? value.sourceId : String(value.id ?? "terms:entry"),
      readOnly: false,
      type: typeof value.type === "string" ? value.type : "terms",
      ...(value.pending === undefined && value.status === "pending_review" ? { pending: true } : {}),
    }));
    if (includeDeleted) {
      for (const trash of snapshot.trash) {
        const value = trash.item;
        termRows.push({
          ...value,
          id: String(value.id ?? "terms:deleted"),
          ...(typeof value.id === "string" ? { entryId: value.id } : {}),
          ja: String(value.ja ?? ""),
          zh: String(value.zh ?? ""),
          archive: "terms",
          archiveFile: "terms.json",
          sourceId: typeof value.sourceId === "string" ? value.sourceId : String(value.id ?? "terms:deleted"),
          readOnly: false,
          deletedAt: trash.deletedAt,
          type: typeof value.type === "string" ? value.type : "terms",
          ...(value.pending === undefined && value.status === "pending_review" ? { pending: true } : {}),
        });
      }
    }
    byArchive.set("terms", termRows);
    const usedIds = new Set(termRows.map((term) => String(term.id ?? "")));

    for (const { archive, file } of TERMINOLOGY_ARCHIVES) {
      if (archive === "terms") continue;
      const rows: TermRecord[] = [];
      const raw = snapshot.archives[archive];
      for (let index = 0; index < raw.length; index += 1) {
        const value = raw[index]!;
        const sourceId = typeof value.sourceId === "string" ? value.sourceId : typeof value.id === "string" ? value.id : undefined;
        const safeSourceId = typeof value.id === "string" && SAFE_TERM_ID.test(value.id) ? value.id : `entry-${index + 1}`;
        const id = uniqueTermId(`${archive}:${safeSourceId}`, usedIds);
        let ja = typeof value.ja === "string" ? value.ja : "";
        let zh = typeof value.zh === "string" ? value.zh : "";
        /** 内置字典规则的说明（磁盘上没有时按 find 回填，见下） */
        let seededNote: string | undefined;
        /** 是否是软件播种的内置规则（来源标注，见下） */
        let builtin = false;
        if (archive === "voice") {
          const character = typeof value.character === "string" ? value.character : "";
          const selfRefJa = typeof value.selfRefJa === "string" ? value.selfRefJa : "";
          const selfRefZh = typeof value.selfRefZh === "string" ? value.selfRefZh : "";
          const zhStrategy = typeof value.zhStrategy === "string" ? value.zhStrategy : "";
          ja = [character, selfRefJa].filter(Boolean).join(" / ") || `voice-${index + 1}`;
          zh = selfRefZh || zh || zhStrategy || character || "语气策略";
        } else if (DICT_ARCHIVES.includes(archive)) {
          // 字典条目的权威字段是 find/replace；ja/zh 只是术语面这两列的投影名
          ja = typeof value.find === "string" ? value.find : `${archive}-${index + 1}`;
          zh = typeof value.replace === "string" ? value.replace : "";
          // 内置规则的说明与来源标注：按 find 认出来（只读侧，不写盘）。
          // 内置表现已清空（见 seed-rules.ts），这段因此不会命中任何条目；
          // 保留它是为了「日后真有普遍成立的默认规则」时说明与来源仍然显示得出来。
          const seeded = SEEDED_POST_DICT_RULES.find((rule) => rule.find === value.find);
          if (seeded) {
            builtin = true;
            if (typeof value.note !== "string" || !value.note) seededNote = seeded.note;
          }
        } else if (archive === "noTranslate") {
          // 禁翻是恒等映射：两列同值，界面上「译法」一栏因此不可编辑
          ja = typeof value.ja === "string" ? value.ja : `no-translate-${index + 1}`;
          zh = ja;
        } else {
          if (!ja) ja = typeof value.character === "string" ? value.character : `${archive}-${index + 1}`;
          if (!zh) zh = typeof value.zhStrategy === "string" ? value.zhStrategy : ja;
        }
        rows.push({
          ...value,
          ...(seededNote ? { note: seededNote } : {}),
          ...(builtin ? { builtin: true } : {}),
          id,
          // 展示 id 带了档案前缀与去重后缀，仓库里没有这个键。变更要用条目本身的 id。
          ...(typeof value.id === "string" ? { entryId: value.id } : {}),
          ja,
          zh,
          type: typeof value.type === "string" ? value.type : archive === "puns" ? "pun" : archive,
          archive,
          archiveFile: file,
          ...(sourceId ? { sourceId } : {}),
          readOnly: false,
          ...(value.pending === undefined && value.status === "pending_review" ? { pending: true } : {}),
        });
      }
      byArchive.set(archive, rows);
    }
    return { items: TERMINOLOGY_ARCHIVES.flatMap(({ archive }) => byArchive.get(archive) ?? []), revision: snapshot.revision };
  }

  async queryTerms(request: IpcRequestMap["terms.query"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    const search = request.search?.trim().toLocaleLowerCase();
    const filters: TermQueryFilters = request.filters ?? {};
    const archiveSnapshot = await this.readTerminologyArchives(workspace.root, filters.deleted === true);
    if (request.baseRevision !== undefined && request.baseRevision !== archiveSnapshot.revision) {
      return failure(errorFor("conflict", `Terminology revision is ${archiveSnapshot.revision}`, false, { currentRevision: archiveSnapshot.revision, baseRevision: request.baseRevision }));
    }
    const all = archiveSnapshot.items;
    const filtered = all.filter((term) => {
      if (filters.archive && term.archive !== filters.archive) return false;
      if (filters.type && term.type !== filters.type) return false;
      if (filters.status) {
        const status = typeof term.status === "string" ? term.status : term.pending ? "pending_review" : "confirmed";
        if (status !== filters.status) return false;
      }
      if (search) {
        const searchable = JSON.stringify(term).toLocaleLowerCase();
        if (!searchable.includes(search)) return false;
      }
      return true;
    });
    const cursor = request.cursor ?? 0;
    const items = filtered.slice(cursor, cursor + 50);
    const revision = archiveSnapshot.revision;
    this.terminologyRevisions.set(resolve(workspace.root), revision);
    const result: TermQueryResult = { items, nextCursor: cursor + items.length < filtered.length ? cursor + items.length : null, revision };
    return success(result);
  }

  /**
   * 改译法之前先把「旧译名是什么、词表里还有哪些译名」记下来（EX-06）。
   *
   * 必须在术语队列**里面**读：读完再排队的话，两次改名交错就会让第二次拿到
   * 已经被第一次改掉的「旧」译名，追溯扫描找错目标。
   */
  private renameContext(
    snapshot: TerminologySnapshot,
    archive: TermArchive,
    termId: string,
    newZh: unknown,
  ): { ja: string; oldZh: string; newZh: string; otherZh: string[] } | undefined {
    if (archive !== "names" && archive !== "terms") return undefined;
    if (typeof newZh !== "string" || !newZh.trim()) return undefined;
    const target = snapshot.archives[archive]?.find((entry) => entry.id === termId);
    const oldZh = typeof target?.zh === "string" ? target.zh : "";
    const ja = typeof target?.ja === "string" ? target.ja : "";
    if (!oldZh || oldZh === newZh) return undefined;
    const otherZh: string[] = [];
    for (const source of [snapshot.archives.names ?? [], snapshot.archives.terms ?? []]) {
      for (const entry of source) {
        if (entry.id === termId) continue;
        if (typeof entry.zh === "string" && entry.zh) otherZh.push(entry.zh);
      }
    }
    return { ja, oldZh, newZh, otherZh };
  }

  /**
   * 执行追溯改名（EX-06）。**失败不回滚改名本身**——术语表已经改好了，
   * 追溯是补救动作；让它把一次成功的编辑变成报错，作者只会以为改名没生效。
   * 失败写进日志并如实回报 0，不假装做过。
   */
  private async repairRename(
    root: string,
    input: { ja: string; oldZh: string; newZh: string; otherZh: string[] },
  ): Promise<NonNullable<TermMutationResult["renameRepair"]>> {
    try {
      const result = await retroRename({ root }, input);
      // 日志只记数量与判据，excerpt 是译文正文，绝不进日志
      this.log("info", `retro rename ${result.replaced} paragraphs / ${result.chapters.length} chapters, ${result.queued} queued${result.blocked ? ` (blocked: ${result.blocked})` : ""}`);
      return {
        oldZh: input.oldZh,
        newZh: input.newZh,
        replaced: result.replaced,
        chapters: result.chapters.length,
        queued: result.queued,
        ...(result.blocked ? { blocked: result.blocked } : {}),
      };
    } catch (cause) {
      this.log("warn", `retro rename failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      return { oldZh: input.oldZh, newZh: input.newZh, replaced: 0, chapters: 0, queued: 0 };
    }
  }

  private async termMutation(
    workspaceId: string,
    termId: string,
    baseRevision: number,
    action: "updated" | "deleted" | "restored",
    patch?: Record<string, unknown>,
    archive: TermArchive = "terms",
  ): Promise<AnyResult> {
    const workspace = this.workspace(workspaceId);
    const key = `${workspace.root}:terminology`;
    const operationId = `ipc:${createHash("sha256").update(JSON.stringify({ action, archive, termId, baseRevision, patch })).digest("hex")}`;
    return this.trackWrite(this.enqueue(key, async () => {
      try {
        const repository = this.terminologyRepository(workspace.root);
        const rename = action === "updated"
          ? this.renameContext(await repository.readSnapshot(), archive, termId, patch?.zh)
          : undefined;
        const result = await repository.mutateTerms({ operationId, action, termId, baseRevision, patch, archive });
        if (result.commit) await this.emitTerminologyCommit(workspace, result.commit);
        // BQ-06：术语表变更 → 全书审校失效
        await this.markBookReviewStale(workspace.root, `术语表变更（${action} ${termId}）`);
        const renameRepair = rename ? await this.repairRename(workspace.root, rename) : undefined;
        return success({
          workspaceId, chapterId: "terms", revision: result.snapshot.revision, savedAt: Date.now(), reloadRequired: true,
          ...(renameRepair ? { renameRepair } : {}),
        } satisfies TermMutationResult);
      } catch (cause) {
        const repositoryError = this.repositoryError(cause);
        if (repositoryError) return failure(repositoryError);
        throw cause;
      }
    }));
  }

  async createTerm(request: IpcRequestMap["terms.create"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    const entry = request.archive === "voice"
      ? { character: request.character, selfRefJa: request.ja, selfRefZh: request.zh, zhStrategy: request.strategy ?? "", particlesJa: [], politeStyle: "mixed", ...(request.gender === "female" || request.gender === "male" ? { gender: request.gender } : {}), status: "confirmed", confidence: 1 }
      : DICT_ARCHIVES.includes(request.archive)
        // type 承载「字面量还是正则」：字典没有术语那种分类维度，复用这个字段免去新增契约字段
        ? { find: request.ja, replace: request.zh, type: request.type === "regex" ? "regex" : "literal", enabled: request.enabled !== false, status: "confirmed" }
        : request.archive === "noTranslate"
          ? { ja: request.ja, ...(request.strategy ? { note: request.strategy } : {}), type: "no_translate", enabled: request.enabled !== false, status: "confirmed" }
          // 双关卡的 note 是梗的解释，会原样进译文的（译注: …）——不映射的话
          // 作者手动登记的梗在译文里变成一对空括号。
          : { ja: request.ja, zh: request.zh, type: request.type ?? request.archive, ...(request.archive === "puns" && request.strategy ? { note: request.strategy } : {}), status: "confirmed", confidence: 1 };
    const operationId = `ipc:${createHash("sha256").update(JSON.stringify({ action: "created", archive: request.archive, baseRevision: request.baseRevision, entry })).digest("hex")}`;
    // 与 termMutation 对齐：同一把术语队列 + trackWrite。
    // 缺 trackWrite 时新建术语对 flushPendingWrites 不可见 → 关窗排空会漏掉它（DEF-07）。
    return this.trackWrite(this.enqueue(`${workspace.root}:terminology`, async () => {
      try {
        const result = await this.terminologyRepository(workspace.root).mergeEntries({ operationId, action: "created", baseRevision: request.baseRevision, entries: [{ archive: request.archive, entry }] });
        if (result.commit) await this.emitTerminologyCommit(workspace, result.commit);
        await this.markBookReviewStale(workspace.root, `术语表变更（created ${request.archive}）`);
        return success({ workspaceId: request.workspaceId, chapterId: "terms", revision: result.snapshot.revision, savedAt: Date.now(), reloadRequired: true } satisfies TermMutationResult);
      } catch (cause) {
        const repositoryError = this.repositoryError(cause);
        if (repositoryError) return failure(repositoryError);
        throw cause;
      }
    }));
  }

  updateTerm(request: IpcRequestMap["terms.update"]): Promise<AnyResult> {
    const archive = request.archive ?? "terms";
    const termId = archive !== "terms" && request.termId.startsWith(`${archive}:`) ? request.termId.slice(archive.length + 1) : request.termId;
    const patch = archive === "voice"
      ? { character: request.character, selfRefJa: request.ja, selfRefZh: request.zh, zhStrategy: request.strategy ?? "", particlesZhStrategy: request.strategy ?? "", gender: request.gender === "female" || request.gender === "male" ? request.gender : "", status: "confirmed" }
      : DICT_ARCHIVES.includes(archive)
        ? { find: request.ja, replace: request.zh, type: request.type === "regex" ? "regex" : "literal", enabled: request.enabled !== false, status: "confirmed" }
        : archive === "noTranslate"
          ? { ja: request.ja, ...(request.strategy ? { note: request.strategy } : {}), type: "no_translate", enabled: request.enabled !== false, status: "confirmed" }
          // 与 createTerm 对称：编辑双关卡时 note 同样要跟着走，否则改一次译法就把梗的解释清空。
          // provenance 翻 author（ADR-0008 终审）：作者动过手就是终审——编辑暂定词条后
          // 它不能继续标着 model，否则终审队列里永远清不掉这一条。改 zh 时既有的
          // renameContext 会触发追溯改名，终审改译因此完整闭环。
          : { ja: request.ja, zh: request.zh, ...(request.type ? { type: request.type } : {}), ...(archive === "puns" ? { note: request.strategy ?? "" } : {}), status: "confirmed", provenance: "author" };
    return this.termMutation(request.workspaceId, termId, request.baseRevision, "updated", patch, archive);
  }

  /** 追溯改名的复查队列（EX-06）。已解决的条目保留，作者要能回看改过哪里。 */
  async listRenameReview(request: IpcRequestMap["rename.review"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    const queue = await readRenameReview({ root: workspace.root });
    return success({
      entries: queue.entries,
      pending: queue.entries.filter((entry) => !entry.resolvedAt).length,
    } satisfies RenameReviewResult);
  }

  resolveRenameReviewEntry(request: IpcRequestMap["rename.resolve"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    return this.trackWrite(this.enqueue(`${workspace.root}:terminology`, async () => {
      const resolved = await resolveRenameReview({ root: workspace.root }, request.entryId);
      return success({ resolved });
    }));
  }

  deleteTerm(request: IpcRequestMap["terms.delete"]): Promise<AnyResult> {
    return this.termMutation(request.workspaceId, request.termId, request.baseRevision, "deleted", undefined, request.archive ?? "terms");
  }

  restoreTerm(request: IpcRequestMap["terms.restore"]): Promise<AnyResult> {
    return this.termMutation(request.workspaceId, request.termId, request.baseRevision, "restored", undefined, request.archive ?? "terms");
  }
}
