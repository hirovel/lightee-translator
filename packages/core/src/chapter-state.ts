import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appendLine, atomicWriteFile, readJson, withFileMutationQueue, WorkspacePaths } from "./atomic-fs.js";
import { advanceState, createChapterStatus, type ChapterState, type ChapterStatus } from "./state-machine.js";

export const CHAPTER_STATE_FORMAT_VERSION = 1 as const;
export const CHAPTER_EVENT_FORMAT_VERSION = 1 as const;

export type ChapterWorkflowStatus = ChapterStatus & {
  /** Translator executions, including resumed interrupted work. */
  attempt: number;
  /** Translator failures that returned the chapter to ready. */
  retryCount: number;
  /** Most recent failure, if any. */
  lastError: string | null;
  /** Reason for the most recent accepted transition. */
  lastReason: string | null;
  /** Correlation ID of the run that last changed this chapter. */
  runId: string | null;
  /** Monotonic transition sequence used to reject stale renderer hydration. */
  transitionCount: number;
  /**
   * 章节是否曾经通过审校（进入过 approved）。一旦为 true 永不回退。
   *
   * 存在的意义是让「是否有过正式译文」成为 O(1) 的快照字段，而不是每次章节加载
   * 都全量扫描事件日志（A-2/B-6）。事件日志回归审计轨迹，不再是运行时判定依据。
   */
  everApproved: boolean;
  /**
   * 本章的 approved 是作者显式裁决的结果（`chapter.accept`），不是审校自然通过。
   *
   * 存在的意义是让 L4 人工确认压得住下层：全文审校发现 high 时会自动把章节打回重译，
   * 那会静默撤销作者刚做的决定。带上这个标记，自动修订就知道该绕开它。
   * 作者主动重译（transition 到 translating）即视为收回该决定，标记清除。
   */
  authorAccepted?: boolean;
};

/** 事件日志压缩阈值：超过此行数时在锁内压缩 */
export const CHAPTER_EVENTS_COMPACT_THRESHOLD = 5_000;
/** 压缩后每章保留的最近事件条数（approved/stuck 转移额外全量保留） */
export const CHAPTER_EVENTS_KEEP_RECENT = 50;

export interface ChapterStateSnapshot {
  formatVersion: typeof CHAPTER_STATE_FORMAT_VERSION;
  updatedAt: string;
  chapters: Record<string, ChapterWorkflowStatus>;
  /** Last event copied into the snapshot so a crash before append can be repaired. */
  lastEvent: ChapterStateEvent | null;
}

export interface ChapterStateEvent {
  formatVersion: typeof CHAPTER_EVENT_FORMAT_VERSION;
  eventId: string;
  runId: string;
  chapterId: string;
  at: string;
  from: ChapterState;
  to: ChapterState;
  reason: string;
  status: ChapterWorkflowStatus;
}

export interface ChapterTransitionOptions {
  runId?: string;
  reason?: string;
  lastError?: string | null;
  /** 标记本次 approved 出自作者显式裁决（见 ChapterWorkflowStatus.authorAccepted） */
  authorAccepted?: boolean;
}

export interface ChapterAttemptOptions {
  runId?: string;
  reason?: string;
}

export class ChapterStateStoreError extends Error {
  constructor(readonly code: "invalid_snapshot" | "invalid_events", message: string) {
    super(message);
    this.name = "ChapterStateStoreError";
  }
}

const chapterLockQueues = new Map<string, Promise<unknown>>();
const chapterLockContext = new AsyncLocalStorage<Set<string>>();
const CHAPTER_LOCK_TIMEOUT_MS = 10_000;
// 死锁回收阈值：活进程每 30s heartbeat 刷新 mtime，90s（3 个周期）内无刷新即可视为死锁。
// 之前 10 分钟太久——应用异常退出后残留死锁，用户重启要等 10 分钟才能用。
const CHAPTER_LOCK_STALE_MS = 90_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface ChapterLockOwner {
  pid: number;
  token: string;
  acquiredAt: number;
}

async function readChapterLock(lockPath: string): Promise<{ owner: ChapterLockOwner; directory: boolean }> {
  const info = await stat(lockPath);
  const ownerPath = info.isDirectory() ? join(lockPath, "owner.json") : lockPath;
  const owner = JSON.parse(await readFile(ownerPath, "utf8")) as ChapterLockOwner;
  if (!Number.isInteger(owner.pid) || typeof owner.token !== "string" || typeof owner.acquiredAt !== "number") throw new Error("Invalid chapter lock owner");
  return { owner, directory: info.isDirectory() };
}

async function removeChapterLock(lockPath: string): Promise<void> {
  const current = await stat(lockPath).catch(() => null);
  await rm(lockPath, { recursive: Boolean(current?.isDirectory()), force: true });
}

async function restoreQuarantinedChapterLock(quarantinePath: string, lockPath: string): Promise<void> {
  const info = await stat(quarantinePath).catch(() => null);
  if (!info || info.isDirectory()) {
    // The current implementation creates files; old directory locks are only
    // retained long enough for their live owner to release them.
    await removeChapterLock(quarantinePath);
    return;
  }
  try {
    // Hard-link creation is atomic and never replaces a lock created while the
    // quarantine was being inspected.
    await link(quarantinePath, lockPath);
  } catch {
    // A different owner already occupies the canonical path.
  }
  await removeChapterLock(quarantinePath);
}

async function reclaimStaleChapterLock(lockPath: string): Promise<void> {
  const quarantinePath = `${lockPath}.reclaim-${randomUUID()}`;
  try {
    // Only one contender can rename the stale lock. A second contender sees
    // ENOENT and cannot later remove a lock created by the first contender.
    await rename(lockPath, quarantinePath);
  } catch {
    return;
  }
  try {
    const current = await readChapterLock(quarantinePath);
    if (processAlive(current.owner.pid)) {
      // The owner refreshed between the initial stale check and quarantine.
      await restoreQuarantinedChapterLock(quarantinePath, lockPath);
      return;
    }
  } catch {
    // A malformed stale lock has no live owner and can be discarded.
  }
  await removeChapterLock(quarantinePath);
}

async function acquireChapterLock(root: string): Promise<() => Promise<void>> {
  const paths = new WorkspacePaths(root);
  const lockPath = paths.resolve("state/chapter-state.lock");
  const token = randomUUID();
  await mkdir(paths.resolve("state"), { recursive: true });
  const started = Date.now();
  while (Date.now() - started < CHAPTER_LOCK_TIMEOUT_MS) {
    try {
      // A single exclusive file creation publishes ownership atomically. The
      // directory form is read only for compatibility with an older lock.
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() } satisfies ChapterLockOwner), { encoding: "utf8", flag: "wx" });
      const heartbeat = setInterval(() => {
        void utimes(lockPath, new Date(), new Date()).catch(() => undefined);
      }, 30_000);
      heartbeat.unref?.();
      return async () => {
        clearInterval(heartbeat);
        const releasePath = `${lockPath}.release-${token}`;
        try {
          await rename(lockPath, releasePath);
          const current = await readChapterLock(releasePath);
          if (current.owner.token === token) await removeChapterLock(releasePath);
          else await restoreQuarantinedChapterLock(releasePath, lockPath);
        } catch {
          // The lock was already reclaimed or the process is shutting down.
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EISDIR") throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > CHAPTER_LOCK_STALE_MS) {
          let current: { owner?: ChapterLockOwner } = {};
          try { current = await readChapterLock(lockPath); } catch { /* a disappearing or malformed lock is retried */ }
          if (!current.owner?.pid || !processAlive(current.owner.pid)) await reclaimStaleChapterLock(lockPath);
        }
      } catch {
        // The owner may be releasing the lock; retry.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  throw new Error(`Chapter workspace is locked: ${root}`);
}

export async function withChapterWorkspaceLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const key = new WorkspacePaths(root).root;
  const active = chapterLockContext.getStore();
  if (active?.has(key)) return fn();
  const previous = chapterLockQueues.get(key) ?? Promise.resolve();
  const execute = async (): Promise<T> => {
    const release = await acquireChapterLock(key);
    const nextActive = new Set(active ?? []);
    nextActive.add(key);
    try {
      return await chapterLockContext.run(nextActive, fn);
    } finally {
      await release();
    }
  };
  const next = previous.then(execute, execute);
  chapterLockQueues.set(key, next.catch(() => undefined));
  return next;
}

function initialStatus(chapterId: string): ChapterWorkflowStatus {
  return {
    ...createChapterStatus(chapterId),
    attempt: 0,
    retryCount: 0,
    lastError: null,
    lastReason: null,
    runId: null,
    transitionCount: 0,
    everApproved: false,
  };
}

function emptySnapshot(): ChapterStateSnapshot {
  return {
    formatVersion: CHAPTER_STATE_FORMAT_VERSION,
    updatedAt: new Date(0).toISOString(),
    chapters: {},
    lastEvent: null,
  };
}

function isChapterState(value: unknown): value is ChapterState {
  return typeof value === "string" && [
    "imported",
    "ready",
    "translating",
    "translated",
    "reviewing",
    "revising",
    "approved",
    "stuck",
  ].includes(value);
}

function isValidStatus(chapterId: string, value: unknown): value is ChapterWorkflowStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.chapterId === chapterId
    && isChapterState(row.state)
    && Number.isSafeInteger(row.version) && Number(row.version) >= 0
    && Number.isSafeInteger(row.reviseCount) && Number(row.reviseCount) >= 0
    && (row.lastActivityAt === null || typeof row.lastActivityAt === "string")
    && typeof row.userModified === "boolean"
    && (row.recheckReason === null || typeof row.recheckReason === "string")
    && Number.isSafeInteger(row.attempt) && Number(row.attempt) >= 0
    && Number.isSafeInteger(row.retryCount) && Number(row.retryCount) >= 0
    && (row.lastError === null || typeof row.lastError === "string")
    && (row.lastReason === null || typeof row.lastReason === "string")
    && (row.runId === null || typeof row.runId === "string")
    && (row.transitionCount === undefined || (Number.isSafeInteger(row.transitionCount) && Number(row.transitionCount) >= 0))
    // everApproved 允许缺失：旧快照由 withTransaction 一次性迁移补齐
    && (row.everApproved === undefined || typeof row.everApproved === "boolean");
}

/** 单行 → 事件；任何形式的不合法（含 JSON 解析失败）返回 null，由调用方决定恢复策略 */
function parseEventLine(line: string): ChapterStateEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  return isValidEvent(value) ? value : null;
}

function isValidEvent(value: unknown): value is ChapterStateEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<ChapterStateEvent>;
  return event.formatVersion === CHAPTER_EVENT_FORMAT_VERSION
    && typeof event.eventId === "string"
    && typeof event.runId === "string"
    && typeof event.chapterId === "string"
    && typeof event.at === "string"
    && isChapterState(event.from)
    && isChapterState(event.to)
    && typeof event.reason === "string"
    && Boolean(event.status)
    && isValidStatus(event.chapterId, event.status);
}

/** 旧快照（缺 everApproved 字段）的章节 id，供 withTransaction 一次性迁移 */
function validateSnapshot(value: unknown, legacyEverApproved?: string[]): ChapterStateSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChapterStateStoreError("invalid_snapshot", "chapter_state.json must contain an object");
  }
  const record = value as Record<string, unknown>;
  if (record.formatVersion !== CHAPTER_STATE_FORMAT_VERSION || typeof record.updatedAt !== "string" || !record.chapters || typeof record.chapters !== "object" || Array.isArray(record.chapters)) {
    throw new ChapterStateStoreError("invalid_snapshot", "chapter_state.json has an unsupported format");
  }
  const chapters: Record<string, ChapterWorkflowStatus> = {};
  for (const [chapterId, status] of Object.entries(record.chapters as Record<string, unknown>)) {
    if (!isValidStatus(chapterId, status)) {
      throw new ChapterStateStoreError("invalid_snapshot", `chapter_state.json contains invalid chapter ${chapterId}`);
    }
    if (status.everApproved === undefined) legacyEverApproved?.push(chapterId);
    chapters[chapterId] = {
      ...status,
      transitionCount: status.transitionCount ?? 0,
      // 未迁移前的保守下界：当前就是 approved 一定为 true；其余等迁移时查事件日志
      everApproved: status.everApproved ?? status.state === "approved",
    };
  }
  const lastEvent = record.lastEvent === undefined || record.lastEvent === null ? null : isValidEvent(record.lastEvent) ? record.lastEvent : null;
  if (record.lastEvent !== undefined && record.lastEvent !== null && lastEvent === null) {
    throw new ChapterStateStoreError("invalid_snapshot", "chapter_state.json contains an invalid lastEvent");
  }
  return { formatVersion: CHAPTER_STATE_FORMAT_VERSION, updatedAt: record.updatedAt, chapters, lastEvent };
}

function cloneSnapshot(snapshot: ChapterStateSnapshot): ChapterStateSnapshot {
  return {
    formatVersion: snapshot.formatVersion,
    updatedAt: snapshot.updatedAt,
    chapters: Object.fromEntries(Object.entries(snapshot.chapters).map(([id, status]) => [id, { ...status }])),
    lastEvent: snapshot.lastEvent ? { ...snapshot.lastEvent, status: { ...snapshot.lastEvent.status } } : null,
  };
}

export class ChapterStateStore {
  private readonly paths: WorkspacePaths;

  constructor(root: string) {
    this.paths = new WorkspacePaths(root);
  }

  /** @param legacyEverApproved 若传入，读到缺 everApproved 字段的旧章节时把 id 追加进去（迁移用） */
  async readSnapshot(legacyEverApproved?: string[]): Promise<ChapterStateSnapshot> {
    let raw: unknown;
    try {
      raw = await readJson<unknown>(this.paths.chapterState());
    } catch (error) {
      throw new ChapterStateStoreError("invalid_snapshot", `chapter_state.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    return raw === null ? emptySnapshot() : validateSnapshot(raw, legacyEverApproved);
  }

  async readChapter(chapterId: string): Promise<ChapterWorkflowStatus> {
    const snapshot = await this.readSnapshot();
    const status = snapshot.chapters[chapterId];
    return status ? { ...status } : initialStatus(chapterId);
  }

  /** Caller must already own withTransaction(). */
  async readChapterInTransaction(chapterId: string): Promise<ChapterWorkflowStatus> {
    return this.readChapter(chapterId);
  }

  /**
   * 事务入口的日志维护：补回崩溃丢失的 lastEvent、一次性迁移 everApproved、机会式压缩。
   * 只在本来就要读事件日志时（存在 lastEvent 或存在待迁移章节）读，不新增扫描成本。
   */
  private async reconcileEventsInTransaction(snapshot: ChapterStateSnapshot, legacyEverApproved: string[]): Promise<void> {
    if (!snapshot.lastEvent && legacyEverApproved.length === 0) return;
    const events = await this.readEvents();
    if (snapshot.lastEvent && !events.some((event) => event.eventId === snapshot.lastEvent!.eventId)) {
      await appendLine(this.paths.eventsLog(), JSON.stringify(snapshot.lastEvent));
      events.push(snapshot.lastEvent);
    }
    if (legacyEverApproved.length > 0) {
      await this.migrateEverApprovedInTransaction(snapshot, legacyEverApproved, events);
    }
    await this.compactEventsInTransaction(events);
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return withChapterWorkspaceLock(this.paths.root, async () => {
      const legacyEverApproved: string[] = [];
      const snapshot = await this.readSnapshot(legacyEverApproved);
      await this.reconcileEventsInTransaction(snapshot, legacyEverApproved);
      return fn();
    });
  }

  async ensureChapter(chapterId: string): Promise<ChapterWorkflowStatus> {
    return this.withTransaction(() => this.ensureChapterInTransaction(chapterId));
  }

  /** Caller must already own withTransaction(). */
  async ensureChapterInTransaction(chapterId: string): Promise<ChapterWorkflowStatus> {
    return withFileMutationQueue(this.paths.chapterState(), async () => {
      const snapshot = await this.readSnapshot();
      const existing = snapshot.chapters[chapterId];
      if (existing) return { ...existing };
      const next = cloneSnapshot(snapshot);
      const status = initialStatus(chapterId);
      next.chapters[chapterId] = status;
      next.updatedAt = new Date().toISOString();
      await atomicWriteFile(this.paths.chapterState(), JSON.stringify(next, null, 2) + "\n");
      return { ...status };
    });
  }

  async recordAttempt(chapterId: string, options: ChapterAttemptOptions = {}): Promise<ChapterWorkflowStatus> {
    return this.withTransaction(() => this.recordAttemptInTransaction(chapterId, options));
  }

  /** Caller must already own withTransaction(). */
  async recordAttemptInTransaction(chapterId: string, options: ChapterAttemptOptions = {}): Promise<ChapterWorkflowStatus> {
    return withFileMutationQueue(this.paths.chapterState(), async () => {
      const before = await this.readSnapshot();
      const current = before.chapters[chapterId] ?? initialStatus(chapterId);
      const next: ChapterWorkflowStatus = {
        ...current,
        attempt: current.attempt + 1,
        lastActivityAt: new Date().toISOString(),
        lastError: null,
        lastReason: options.reason ?? "translator execution",
        runId: options.runId ?? current.runId,
      };
      const after = cloneSnapshot(before);
      after.chapters[chapterId] = next;
      after.updatedAt = new Date().toISOString();
      await atomicWriteFile(this.paths.chapterState(), JSON.stringify(after, null, 2) + "\n");
      return { ...next };
    });
  }

  async transition(
    chapterId: string,
    to: ChapterState,
    options: ChapterTransitionOptions = {},
  ): Promise<ChapterWorkflowStatus> {
    return this.withTransaction(() => this.transitionInTransaction(chapterId, to, options));
  }

  /** Caller must already own withTransaction(). */
  async transitionInTransaction(
    chapterId: string,
    to: ChapterState,
    options: ChapterTransitionOptions = {},
  ): Promise<ChapterWorkflowStatus> {
    return withFileMutationQueue(this.paths.chapterState(), async () => {
      const before = await this.readSnapshot();
      const current = before.chapters[chapterId] ?? initialStatus(chapterId);
      const reason = options.reason ?? `${current.state} -> ${to}`;
      const runId = options.runId ?? randomUUID();
      const nextBase = advanceState(current, to);
      const next: ChapterWorkflowStatus = {
        ...nextBase,
        attempt: current.attempt + (to === "translating" ? 1 : 0),
        retryCount: current.retryCount + (current.state === "translating" && to === "ready" ? 1 : 0),
        lastError: options.lastError !== undefined
          ? options.lastError
          : to === "translating" || to === "translated" || to === "approved"
            ? null
            : current.lastError,
        lastReason: reason,
        runId,
        transitionCount: current.transitionCount + 1,
        everApproved: current.everApproved || to === "approved",
        // 重新开译 = 作者收回上次的「接受」；其余转移沿用既有标记
        ...(to === "translating" ? { authorAccepted: false } : options.authorAccepted ? { authorAccepted: true } : {}),
      };
      const after = cloneSnapshot(before);
      after.chapters[chapterId] = next;
      after.updatedAt = new Date().toISOString();
      const event: ChapterStateEvent = {
        formatVersion: CHAPTER_EVENT_FORMAT_VERSION,
        eventId: randomUUID(),
        runId,
        chapterId,
        at: after.updatedAt,
        from: current.state,
        to,
        reason,
        status: next,
      };
      after.lastEvent = event;
      try {
        await atomicWriteFile(this.paths.chapterState(), JSON.stringify(after, null, 2) + "\n");
        await appendLine(this.paths.eventsLog(), JSON.stringify(event));
      } catch (error) {
        await atomicWriteFile(this.paths.chapterState(), JSON.stringify(before, null, 2) + "\n").catch(() => undefined);
        throw error;
      }
      return { ...next };
    });
  }

  /**
   * 读取事件日志。**永不因内容损坏抛错**（A-2）。
   *
   * 事件日志是审计轨迹，状态权威在 chapter_state.json。一行坏数据让整个工作区的
   * `chapter.load` 全部失败是不可接受的失效模式——追加写非原子，一次断电就能留下半行。
   *
   * - 坏行全部集中在末尾（其后无任何有效行）= 断电截断 → 保留有效前缀，
   *   原文件先另存为 `events.jsonl.recovered-<ts>` 再重写。
   * - 坏行出现在中段 = 磁盘级破坏 → 整个文件隔离为 `events.jsonl.corrupt-<ts>`，
   *   从空日志重建（快照仍是权威）。
   *
   * 修复动作在章节工作区锁内进行；锁可重入，事务内调用安全。
   */
  async readEvents(): Promise<ChapterStateEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.paths.eventsLog(), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const lines = raw.split(/\r?\n/);
    const events: ChapterStateEvent[] = [];
    let firstBad = -1;
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      const event = parseEventLine(line);
      if (event) {
        events.push(event);
        continue;
      }
      if (firstBad < 0) firstBad = index;
    }
    if (firstBad < 0) return events;
    const tailOnly = !lines.slice(firstBad + 1).some((line) => line.trim() && parseEventLine(line));
    await this.repairEvents(raw, tailOnly ? events : [], tailOnly ? "recovered" : "corrupt");
    return tailOnly ? events : [];
  }

  /** 把损坏前的原始内容另存为审计副本，再用给定的有效事件重写日志。 */
  private async repairEvents(raw: string, keep: ChapterStateEvent[], kind: "recovered" | "corrupt"): Promise<void> {
    const path = this.paths.eventsLog();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await withChapterWorkspaceLock(this.paths.root, async () => {
      await writeFile(`${path}.${kind}-${stamp}`, raw, "utf-8");
      await atomicWriteFile(path, keep.map((event) => JSON.stringify(event)).join("\n") + (keep.length > 0 ? "\n" : ""));
    });
  }

  /**
   * 事件日志压缩（B-6）：超过阈值时保留全部 approved/stuck 转移 + 每章最近 N 条，
   * 其余归档到 `events.archive-<ts>.jsonl`。调用方必须已持有事务锁。
   */
  private async compactEventsInTransaction(events: ChapterStateEvent[]): Promise<void> {
    if (events.length <= CHAPTER_EVENTS_COMPACT_THRESHOLD) return;
    const recentByChapter = new Map<string, Set<string>>();
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]!;
      const seen = recentByChapter.get(event.chapterId) ?? new Set<string>();
      if (seen.size < CHAPTER_EVENTS_KEEP_RECENT) seen.add(event.eventId);
      recentByChapter.set(event.chapterId, seen);
    }
    const keepIds = new Set<string>();
    for (const event of events) {
      if (event.to === "approved" || event.to === "stuck" || recentByChapter.get(event.chapterId)?.has(event.eventId)) {
        keepIds.add(event.eventId);
      }
    }
    const kept = events.filter((event) => keepIds.has(event.eventId));
    const archived = events.filter((event) => !keepIds.has(event.eventId));
    if (archived.length === 0) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await writeFile(join(this.paths.root, "state", `events.archive-${stamp}.jsonl`), archived.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf-8");
    await atomicWriteFile(this.paths.eventsLog(), kept.map((event) => JSON.stringify(event)).join("\n") + (kept.length > 0 ? "\n" : ""));
  }

  /** 旧快照补齐 everApproved：当前 approved ∨ 事件日志里出现过 approved。调用方必须已持有事务锁。 */
  private async migrateEverApprovedInTransaction(snapshot: ChapterStateSnapshot, legacy: string[], events: ChapterStateEvent[]): Promise<void> {
    const approvedInEvents = new Set(events.filter((event) => event.to === "approved").map((event) => event.chapterId));
    const next = cloneSnapshot(snapshot);
    for (const chapterId of legacy) {
      const status = next.chapters[chapterId];
      if (!status) continue;
      status.everApproved = status.state === "approved" || approvedInEvents.has(chapterId);
    }
    await atomicWriteFile(this.paths.chapterState(), JSON.stringify(next, null, 2) + "\n");
  }

  /** 软删除：从快照移除章节 workflow 记录（事件日志 append-only 保留，可审计）。 */
  async removeChapter(chapterId: string): Promise<boolean> {
    return this.withTransaction(() => withFileMutationQueue(this.paths.chapterState(), async () => {
      const before = await this.readSnapshot();
      if (!before.chapters[chapterId]) return false;
      const after = cloneSnapshot(before);
      delete after.chapters[chapterId];
      after.updatedAt = new Date().toISOString();
      await atomicWriteFile(this.paths.chapterState(), JSON.stringify(after, null, 2) + "\n");
      return true;
    }));
  }

  /** 恢复：把删除时的 workflow 记录放回快照（事件日志不追加，保持审计链干净）。 */
  async restoreChapter(chapterId: string, status: ChapterWorkflowStatus): Promise<boolean> {
    return this.withTransaction(() => withFileMutationQueue(this.paths.chapterState(), async () => {
      const before = await this.readSnapshot();
      const after = cloneSnapshot(before);
      after.chapters[chapterId] = { ...status };
      after.updatedAt = new Date().toISOString();
      await atomicWriteFile(this.paths.chapterState(), JSON.stringify(after, null, 2) + "\n");
      return true;
    }));
  }
}
