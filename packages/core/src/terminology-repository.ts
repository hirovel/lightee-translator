import { createHash, randomUUID } from "node:crypto";
import { appendLine, atomicWriteJson, readJson } from "./atomic-fs.js";
import { link, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * 档案清单。前五类是 Agent 检测 + 作者确认的成果（走确认卡）；
 * 后三类是 R1 的作者字典（译前规整 / 译后替换 / 禁翻），纯 L0 手工维护、不产生卡片，
 * 但同样吃仓库的 revision、事务、幂等与投影——R2-1 冻结静态前缀要靠 revision 判定字节是否变化。
 */
export const TERMINOLOGY_ARCHIVES = ["names", "terms", "voice", "onomatopoeia", "puns", "preDict", "postDict", "noTranslate"] as const;
export type TerminologyArchive = (typeof TERMINOLOGY_ARCHIVES)[number];
export type TerminologyEntry = Record<string, unknown>;

export interface TerminologyTrashEntry {
  item: TerminologyEntry;
  deletedAt: number;
  originalIndex?: number;
  /** 词条来自哪个档案。缺省 = terms（历史回收站条目只可能来自 terms） */
  archive?: TerminologyArchive;
}

export type TerminologyAction = "prepared" | "confirmed" | "created" | "updated" | "deleted" | "restored" | "recovered" | "status";

export interface TerminologyCommit {
  commitId: string;
  operationId: string;
  revision: number;
  archives: TerminologyArchive[];
  action: TerminologyAction;
  timestamp: number;
}

export interface TerminologySnapshot {
  schemaVersion: 1;
  revision: number;
  updatedAt: number | null;
  archives: Record<TerminologyArchive, TerminologyEntry[]>;
  trash: TerminologyTrashEntry[];
  lastCommit: TerminologyCommit | null;
  operations: TerminologyCommit[];
}

export interface TerminologyMergeEntry {
  archive: TerminologyArchive;
  entry: TerminologyEntry;
}

export interface TerminologyMergeInput {
  operationId: string;
  baseRevision?: number;
  action: "prepared" | "confirmed" | "created";
  entries: TerminologyMergeEntry[];
}

export interface TerminologyTermsMutationInput {
  operationId: string;
  action: "updated" | "deleted" | "restored";
  termId: string;
  baseRevision: number;
  archive?: TerminologyArchive;
  patch?: TerminologyEntry;
}

export interface TerminologyMutationResult {
  snapshot: TerminologySnapshot;
  commit: TerminologyCommit | null;
}

export type TerminologyRepositoryErrorCode = "conflict" | "not_found" | "busy" | "invalid";

export class TerminologyRepositoryError extends Error {
  constructor(
    readonly code: TerminologyRepositoryErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TerminologyRepositoryError";
  }
}

const SNAPSHOT_FILE = "terminology-snapshot.json";
const EVENT_FILE = "terminology-events.jsonl";
const LOCK_FILE = "terminology.lock";
const TRASH_FILE = "term-trash.json";
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const PROJECTION_FILES: Record<TerminologyArchive, string> = {
  names: "names.json",
  terms: "terms.json",
  voice: "voice.json",
  onomatopoeia: "onomatopoeia.json",
  puns: "puns.json",
  preDict: "pre-dict.json",
  postDict: "post-dict.json",
  noTranslate: "no-translate.json",
};
const workspaceQueues = new Map<string, Promise<unknown>>();
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

function emptyArchives(): Record<TerminologyArchive, TerminologyEntry[]> {
  return { names: [], terms: [], voice: [], onomatopoeia: [], puns: [], preDict: [], postDict: [], noTranslate: [] };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isEntry(value: unknown): value is TerminologyEntry {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  let suffix = 2;
  while (used.has(id)) id = `${base}-${suffix++}`;
  used.add(id);
  return id;
}

function normalizedRows(archive: TerminologyArchive, raw: unknown[]): TerminologyEntry[] {
  const used = new Set<string>();
  return raw.filter(isEntry).map((entry, index) => {
    const rawId = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : undefined;
    const safeRawId = rawId && SAFE_ID.test(rawId) ? rawId : undefined;
    const fallback = archive === "terms" ? `terms:entry-${index + 1}` : `entry-${index + 1}`;
    const id = uniqueId(safeRawId ?? fallback, used);
    const sourceId = rawId && rawId !== id ? { sourceId: rawId } : {};
    if (archive === "voice") {
      const character = String(entry.character ?? "").trim();
      if (/^(?:unknown(?:_character)?|未知(?:角色|人物)?|不明|未确定)$/i.test(character)) {
        const sanitized: TerminologyEntry = { ...entry, ...sourceId, id, character: "", status: "pending_review" };
        if (typeof sanitized.ja === "string" && /unknown(?:_character)?/i.test(sanitized.ja)) delete sanitized.ja;
        if (typeof sanitized.context === "string") sanitized.context = sanitized.context.replace(/^unknown(?:_character)?\s*:\s*/i, "");
        return sanitized;
      }
    }
    return { ...entry, ...sourceId, id };
  });
}

function normalizedSnapshot(value: unknown): TerminologySnapshot | null {
  if (!isEntry(value) || value.schemaVersion !== 1 || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0) return null;
  const revision = value.revision;
  const rawArchives = isEntry(value.archives) ? value.archives : {};
  const archives = emptyArchives();
  for (const archive of TERMINOLOGY_ARCHIVES) {
    const rows = rawArchives[archive];
    archives[archive] = Array.isArray(rows) ? normalizedRows(archive, rows) : [];
  }
  const rawTrash = Array.isArray(value.trash) ? value.trash : [];
  const trash = rawTrash.flatMap((item) => {
    if (!isEntry(item) || !isEntry(item.item) || typeof item.deletedAt !== "number") return [];
    return [{
      item: item.item,
      deletedAt: item.deletedAt,
      ...(typeof item.originalIndex === "number" ? { originalIndex: item.originalIndex } : {}),
      // 回收站条目的来源档案（TP-2）：白名单净化器少了这一条时，删掉的人名
      // 落盘再读回就丢了归属，还原会静默进 terms——按清单校验后保留。
      ...(TERMINOLOGY_ARCHIVES.includes(item.archive as TerminologyArchive) ? { archive: item.archive as TerminologyArchive } : {}),
    }];
  });
  const operations = Array.isArray(value.operations)
    ? value.operations.filter((item): item is TerminologyCommit => isCommit(item)).slice(-100)
    : [];
  const lastCommit = isCommit(value.lastCommit) ? value.lastCommit : null;
  return {
    schemaVersion: 1,
    revision,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : null,
    archives,
    trash,
    lastCommit,
    operations,
  };
}

function isCommit(value: unknown): value is TerminologyCommit {
  if (!isEntry(value)) return false;
  return typeof value.commitId === "string"
    && typeof value.operationId === "string"
    && Number.isSafeInteger(value.revision)
    && Array.isArray(value.archives)
    && value.archives.every((archive) => TERMINOLOGY_ARCHIVES.includes(archive as TerminologyArchive))
    && typeof value.action === "string"
    && typeof value.timestamp === "number";
}

function naturalKey(archive: TerminologyArchive, entry: TerminologyEntry): string {
  const value = (key: string) => String(entry[key] ?? "").trim().toLocaleLowerCase();
  if (archive === "voice") return [value("character"), value("selfRefJa")].join("\u0000");
  if (archive === "onomatopoeia") return [value("ja"), value("type"), value("scene"), value("strategy")].join("\u0000");
  if (archive === "puns") return [value("ja"), value("zh"), value("note")].join("\u0000");
  // 字典条目的身份是「查找什么」：同一 find 再次提交是改替换文本，不是新增一条。
  // 若把 replace 也纳入身份，改一次译法就多出一条僵尸规则，两条都会依次执行。
  if (archive === "preDict" || archive === "postDict") return value("find");
  if (archive === "noTranslate") return value("ja");
  return [value("ja"), value("type")].join("\u0000");
}

function generatedId(archive: TerminologyArchive, entry: TerminologyEntry): string {
  const digest = createHash("sha256").update(`${archive}\u0000${naturalKey(archive, entry)}`).digest("hex").slice(0, 16);
  return `${archive}-${digest}`;
}

function changed(before: unknown, after: unknown): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

function queueFor<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(root);
  const previous = workspaceQueues.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  workspaceQueues.set(key, next.catch(() => undefined));
  return next;
}

async function processAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface WorkspaceLockOwner {
  pid: number;
  token: string;
  startedAt: number;
}

async function readWorkspaceLock(lockPath: string): Promise<WorkspaceLockOwner> {
  const owner = JSON.parse(await readFile(lockPath, "utf8")) as WorkspaceLockOwner;
  if (!Number.isInteger(owner.pid) || typeof owner.token !== "string" || typeof owner.startedAt !== "number") throw new Error("Invalid terminology lock owner");
  return owner;
}

async function removeWorkspaceLock(lockPath: string): Promise<void> {
  await rm(lockPath, { force: true });
}

async function restoreQuarantinedWorkspaceLock(quarantinePath: string, lockPath: string): Promise<void> {
  try {
    // Hard-link creation is atomic and never replaces a lock created during
    // quarantine inspection.
    await link(quarantinePath, lockPath);
  } catch {
    // A different owner already occupies the canonical path.
  }
  await removeWorkspaceLock(quarantinePath);
}

async function reclaimStaleWorkspaceLock(lockPath: string): Promise<void> {
  const quarantinePath = `${lockPath}.reclaim-${randomUUID()}`;
  try {
    await rename(lockPath, quarantinePath);
  } catch {
    return;
  }
  try {
    const owner = await readWorkspaceLock(quarantinePath);
    if (await processAlive(owner.pid)) {
      await restoreQuarantinedWorkspaceLock(quarantinePath, lockPath);
      return;
    }
  } catch {
    // A malformed stale lock has no live owner and can be discarded.
  }
  await removeWorkspaceLock(quarantinePath);
}

async function acquireWorkspaceLock(root: string): Promise<() => Promise<void>> {
  const stateDir = join(root, "state");
  const lockPath = join(stateDir, LOCK_FILE);
  const token = randomUUID();
  await mkdir(stateDir, { recursive: true });
  const started = Date.now();
  while (Date.now() - started < LOCK_TIMEOUT_MS) {
    try {
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, token, startedAt: Date.now() } satisfies WorkspaceLockOwner) + "\n", { encoding: "utf8", flag: "wx" });
      const heartbeat = setInterval(() => {
        void utimes(lockPath, new Date(), new Date()).catch(() => undefined);
      }, 10_000);
      heartbeat.unref?.();
      return async () => {
        clearInterval(heartbeat);
        const releasePath = `${lockPath}.release-${token}`;
        try {
          await rename(lockPath, releasePath);
          const owner = await readWorkspaceLock(releasePath);
          if (owner.token === token) await removeWorkspaceLock(releasePath);
          else await restoreQuarantinedWorkspaceLock(releasePath, lockPath);
        } catch {
          // The lock was already reclaimed or the process is shutting down.
        }
      };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "EEXIST" && code !== "EISDIR") throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          let owner: WorkspaceLockOwner | null = null;
          try { owner = await readWorkspaceLock(lockPath); } catch { /* a disappearing or malformed lock is retried */ }
          if (!owner || !(await processAlive(owner.pid))) await reclaimStaleWorkspaceLock(lockPath);
        }
      } catch {
        // The lock owner may be replacing or releasing the file; retry below.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  throw new TerminologyRepositoryError("busy", "Terminology workspace is locked", { root });
}

export async function withTerminologyWorkspaceLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  return queueFor(root, async () => {
    const release = await acquireWorkspaceLock(resolve(root));
    try {
      return await fn();
    } finally {
      await release();
    }
  });
}

export class TerminologyRepository {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async readSnapshot(): Promise<TerminologySnapshot> {
    return this.withWriter(async () => clone(await this.ensureSnapshotUnlocked()));
  }

  /** Read while the caller already owns withTerminologyWorkspaceLock. */
  async readSnapshotInTransaction(): Promise<TerminologySnapshot> {
    return clone(await this.ensureSnapshotUnlocked());
  }

  async readEvents(): Promise<TerminologyCommit[]> {
    const raw = await readFile(join(this.root, "state", EVENT_FILE), "utf8").catch(() => "");
    return raw.split(/\r?\n/).flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const value = JSON.parse(line) as unknown;
        return isCommit(value) ? [value] : [];
      } catch {
        return [];
      }
    });
  }

  async mergeEntries(input: TerminologyMergeInput): Promise<TerminologyMutationResult> {
    return this.withWriter(() => this.mergeEntriesInTransaction(input));
  }

  async recordStatus(operationId: string): Promise<TerminologyMutationResult> {
    return this.withWriter(() => this.recordStatusInTransaction(operationId));
  }

  /** Run an archive mutation while the caller already owns withTransaction. */
  async mergeEntriesInTransaction(input: TerminologyMergeInput): Promise<TerminologyMutationResult> {
    const current = await this.ensureSnapshotUnlocked();
      const replay = await this.findOperationUnlocked(current, input.operationId);
      if (replay) return { snapshot: clone(current), commit: clone(replay) };
      this.assertBase(current, input.baseRevision);
      const next = clone(current);
      const affected = new Set<TerminologyArchive>();
      for (const { archive, entry } of input.entries) {
        const rows = next.archives[archive];
        const incoming = { ...entry };
        const requestedId = typeof incoming.id === "string" && incoming.id.trim() && SAFE_ID.test(incoming.id.trim()) ? incoming.id.trim() : generatedId(archive, incoming);
        incoming.id = requestedId;
        const key = naturalKey(archive, incoming);
        const index = rows.findIndex((row) => row.id === requestedId || naturalKey(archive, row) === key);
        if (index >= 0) {
          const existing = rows[index]!;
          /**
           * 「暂定」的两种历史形态（ADR-0008）：
           * - 旧闸门语义：pending / status:"pending_review"（不生效，等确认）；
           * - 新语义：provenance:"model"（**已生效**，登记即注入，未终审）。
           * 两者被终审（confirmed/created）时同一规则：作者的新值必须赢，并落定为
           * author + confirmed——否则终审时作者改的译法会被「旧值赢」静默丢弃。
           * 非暂定（作者定稿）维持旧值赢：模型 prepared 再来也不许动作者拍过板的行。
           */
          const wasProvisional = existing.pending === true || existing.status === "pending_review" || existing.provenance === "model";
          const merged = (input.action === "confirmed" || input.action === "created") && wasProvisional
            ? { ...existing, ...incoming, id: existing.id, pending: false, status: "confirmed", provenance: "author" }
            : { ...incoming, ...existing, id: existing.id };
          if (changed(existing, merged)) {
            rows[index] = merged;
            affected.add(archive);
          }
        } else {
          const used = new Set(rows.flatMap((row) => typeof row.id === "string" ? [row.id] : []));
          incoming.id = uniqueId(requestedId, used);
          rows.push(incoming);
          affected.add(archive);
        }
      }
    return this.commitUnlocked(current, next, input.operationId, input.action, [...affected]);
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return withTerminologyWorkspaceLock(this.root, fn);
  }

  async recordStatusInTransaction(operationId: string): Promise<TerminologyMutationResult> {
    const current = await this.ensureSnapshotUnlocked();
    const replay = await this.findOperationUnlocked(current, operationId);
    if (replay) return { snapshot: clone(current), commit: clone(replay) };
    const timestamp = Date.now();
    const commit: TerminologyCommit = {
      commitId: randomUUID(),
      operationId,
      revision: current.revision,
      archives: [],
      action: "status",
      timestamp,
    };
    const next = clone(current);
    next.updatedAt = timestamp;
    next.lastCommit = commit;
    next.operations = [...next.operations.filter((operation) => operation.operationId !== operationId), commit].slice(-100);
    await this.persistSnapshotUnlocked(next);
    await appendLine(join(this.root, "state", EVENT_FILE), JSON.stringify(commit));
    return { snapshot: clone(next), commit: clone(commit) };
  }

  async mutateTerms(input: TerminologyTermsMutationInput): Promise<TerminologyMutationResult> {
    return this.withWriter(async () => {
      const current = await this.ensureSnapshotUnlocked();
      const replay = await this.findOperationUnlocked(current, input.operationId);
      if (replay) return { snapshot: clone(current), commit: clone(replay) };
      this.assertBase(current, input.baseRevision);
      const next = clone(current);
      const archive = input.archive ?? "terms";
      const rows = next.archives[archive];
      const index = rows.findIndex((entry) => entry.id === input.termId);
      if (input.action !== "restored" && index < 0) throw new TerminologyRepositoryError("not_found", `Terminology entry not found: ${input.termId}`);
      if (input.action === "updated") {
        if (!input.patch) throw new TerminologyRepositoryError("invalid", "Terminology update patch is required");
        rows[index] = { ...rows[index], ...input.patch, id: rows[index]!.id };
      } else if (input.action === "deleted") {
        // 回收站对**所有**档案开放。曾经只许 terms/names 是因为当时只有终审「拒绝」
        // 这一个删除入口；术语表管理界面上线后，作者能看见的每一条都得能删——
        // 白名单一挡，语气/拟声/双关/字典这几栏就成了只进不出的死档案。
        // 回收站条目自带 archive，还原时按它回家（历史条目缺省 terms，语义不变）。
        const [item] = rows.splice(index, 1);
        next.trash.push({ item: item!, deletedAt: Date.now(), originalIndex: index, archive });
      } else {
        if (index >= 0) throw new TerminologyRepositoryError("conflict", `Term is already active: ${input.termId}`);
        let trashIndex = -1;
        for (let cursor = next.trash.length - 1; cursor >= 0; cursor -= 1) {
          if (next.trash[cursor]?.item.id === input.termId) {
            trashIndex = cursor;
            break;
          }
        }
        if (trashIndex < 0) throw new TerminologyRepositoryError("not_found", `Deleted term not found: ${input.termId}`);
        const deleted = next.trash[trashIndex]!;
        // 按回收站条目**自己记录的**档案回家，不信调用方传的——传错 archive 会把人名
        // 还原进 terms 这类静默错位。历史条目没有 archive 字段，缺省 terms（当年只有它可删）。
        const homeArchive = deleted.archive ?? "terms";
        const home = next.archives[homeArchive];
        const insertAt = typeof deleted.originalIndex === "number" ? Math.max(0, Math.min(deleted.originalIndex, home.length)) : home.length;
        home.splice(insertAt, 0, deleted.item);
        next.trash.splice(trashIndex, 1);
        return this.commitUnlocked(current, next, input.operationId, input.action, [homeArchive]);
      }
      return this.commitUnlocked(current, next, input.operationId, input.action, [archive]);
    });
  }

  private async withWriter<T>(fn: () => Promise<T>): Promise<T> {
    return withTerminologyWorkspaceLock(this.root, fn);
  }

  private assertBase(snapshot: TerminologySnapshot, baseRevision: number | undefined): void {
    if (baseRevision !== undefined && baseRevision !== snapshot.revision) {
      throw new TerminologyRepositoryError("conflict", `Terminology revision is ${snapshot.revision}`, { currentRevision: snapshot.revision, baseRevision });
    }
  }

  private async readLegacyArchivesUnlocked(): Promise<{ archives: Record<TerminologyArchive, TerminologyEntry[]>; malformed: boolean }> {
    const archives = emptyArchives();
    let malformed = false;
    for (const archive of TERMINOLOGY_ARCHIVES) {
      try {
        const legacy = await readJson<unknown[]>(join(this.root, "terminology", PROJECTION_FILES[archive]));
        archives[archive] = normalizedRows(archive, Array.isArray(legacy) ? legacy : []);
      } catch {
        malformed = true;
      }
    }
    return { archives, malformed };
  }

  private async ensureSnapshotUnlocked(): Promise<TerminologySnapshot> {
    const snapshotPath = join(this.root, "state", SNAPSHOT_FILE);
    const raw = await readJson<unknown>(snapshotPath);
    let snapshot = normalizedSnapshot(raw);
    if (!snapshot) {
      const { archives } = await this.readLegacyArchivesUnlocked();
      const revisions = await readJson<Record<string, unknown>>(join(this.root, "state", "ipc-revisions.json"));
      const revision = revisions && typeof revisions.terms === "number" && Number.isSafeInteger(revisions.terms) && revisions.terms >= 0 ? revisions.terms : 0;
      snapshot = { schemaVersion: 1, revision, updatedAt: null, archives, trash: await this.readTrashUnlocked(), lastCommit: null, operations: [] };
      await this.persistSnapshotUnlocked(snapshot);
    } else {
      // Before the first repository commit, legacy files remain an intentional compatibility input.
      // This also keeps clean test/import fixtures from racing initial snapshot creation.
      const legacy = await this.readLegacyArchivesUnlocked();
      if (!legacy.malformed && snapshot.revision === 0 && !snapshot.lastCommit && JSON.stringify(legacy.archives) !== JSON.stringify(snapshot.archives)) {
        snapshot.archives = legacy.archives;
        snapshot.trash = await this.readTrashUnlocked();
        await this.persistSnapshotUnlocked(snapshot);
      } else {
        await this.repairProjectionsUnlocked(snapshot);
      }
    }
    await this.ensureEventUnlocked(snapshot);
    return snapshot;
  }

  private async readTrashUnlocked(): Promise<TerminologyTrashEntry[]> {
    const raw = await readJson<unknown>(join(this.root, "state", TRASH_FILE));
    if (!Array.isArray(raw)) return [];
    // archive 必须原样带回来：丢了它，还原时一律按缺省的 terms 回家——
    // 删掉的人名会静默落进普通术语表，作者点「还原」看到的是另一张表多了一行。
    return raw.flatMap((item) => isEntry(item) && isEntry(item.item) && typeof item.deletedAt === "number"
      ? [{
        item: item.item,
        deletedAt: item.deletedAt,
        ...(typeof item.originalIndex === "number" ? { originalIndex: item.originalIndex } : {}),
        ...(TERMINOLOGY_ARCHIVES.includes(item.archive as TerminologyArchive) ? { archive: item.archive as TerminologyArchive } : {}),
      }]
      : []);
  }

  private async findOperationUnlocked(snapshot: TerminologySnapshot, operationId: string): Promise<TerminologyCommit | null> {
    const inSnapshot = snapshot.operations.find((operation) => operation.operationId === operationId);
    if (inSnapshot) return inSnapshot;
    const inEvents = (await this.readEvents()).find((event) => event.operationId === operationId);
    return inEvents ?? null;
  }

  private async repairProjectionsUnlocked(snapshot: TerminologySnapshot): Promise<void> {
    for (const archive of TERMINOLOGY_ARCHIVES) {
      const path = join(this.root, "terminology", PROJECTION_FILES[archive]);
      const current = await readJson<unknown>(path).catch(() => undefined);
      if (JSON.stringify(current) !== JSON.stringify(snapshot.archives[archive])) await atomicWriteJson(path, snapshot.archives[archive]);
    }
    const trashPath = join(this.root, "state", TRASH_FILE);
    const currentTrash = await readJson<unknown>(trashPath).catch(() => undefined);
    if (JSON.stringify(currentTrash) !== JSON.stringify(snapshot.trash)) await atomicWriteJson(trashPath, snapshot.trash);
    const revisionsPath = join(this.root, "state", "ipc-revisions.json");
    const revisions = await readJson<Record<string, unknown>>(revisionsPath) ?? {};
    if (revisions.terms !== snapshot.revision || revisions.terminology !== snapshot.revision) {
      revisions.terms = snapshot.revision;
      revisions.terminology = snapshot.revision;
      await atomicWriteJson(revisionsPath, revisions);
    }
  }

  private async persistSnapshotUnlocked(snapshot: TerminologySnapshot): Promise<void> {
    await atomicWriteJson(join(this.root, "state", SNAPSHOT_FILE), snapshot);
    await this.repairProjectionsUnlocked(snapshot);
    const revisionsPath = join(this.root, "state", "ipc-revisions.json");
    const revisions = await readJson<Record<string, unknown>>(revisionsPath) ?? {};
    revisions.terms = snapshot.revision;
    revisions.terminology = snapshot.revision;
    await atomicWriteJson(revisionsPath, revisions);
  }

  private async ensureEventUnlocked(snapshot: TerminologySnapshot): Promise<void> {
    if (snapshot.operations.length === 0 && !snapshot.lastCommit) return;
    const events = await this.readEvents();
    const known = new Set(events.map((event) => event.commitId));
    const missing = snapshot.operations.filter((operation) => !known.has(operation.commitId));
    if (snapshot.lastCommit && !known.has(snapshot.lastCommit.commitId) && !missing.some((operation) => operation.commitId === snapshot.lastCommit!.commitId)) {
      missing.push(snapshot.lastCommit);
    }
    for (const commit of missing.sort((left, right) => left.revision - right.revision)) {
      await appendLine(join(this.root, "state", EVENT_FILE), JSON.stringify(commit));
    }
  }

  private async commitUnlocked(
    current: TerminologySnapshot,
    next: TerminologySnapshot,
    operationId: string,
    action: TerminologyAction,
    archives: TerminologyArchive[],
  ): Promise<TerminologyMutationResult> {
    if (archives.length === 0 || !changed(current.archives, next.archives) && !changed(current.trash, next.trash)) {
      return { snapshot: clone(current), commit: null };
    }
    const commit: TerminologyCommit = {
      commitId: randomUUID(),
      operationId,
      revision: current.revision + 1,
      archives: [...new Set(archives)],
      action,
      timestamp: Date.now(),
    };
    next.revision = commit.revision;
    next.updatedAt = commit.timestamp;
    next.lastCommit = commit;
    next.operations = [...next.operations.filter((operation) => operation.operationId !== operationId), commit].slice(-100);
    await this.persistSnapshotUnlocked(next);
    await appendLine(join(this.root, "state", EVENT_FILE), JSON.stringify(commit));
    return { snapshot: clone(next), commit: clone(commit) };
  }
}
