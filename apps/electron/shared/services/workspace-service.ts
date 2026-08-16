/**
 * 工作区域服务（RH-11 / design/ipc-service-decomposition.md §2）。
 *
 * 归属：工作区注册表、打开/新建/关闭、概览扫描、会话记忆，以及导入
 * （`import.preview` / `import.text` / `import.run`）。
 *
 * 写权威：工作区注册表文件、`sessions/last.json`、新建工作区的目录骨架。
 * 已打开工作区表（`workspaces`）也在这里——`ctx.workspace()` 就是它的读接口。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { atomicWriteFile, atomicWriteJson, exists, readJson, readText } from "../atomic-file.js";
import { errorFor, failure, success, ServiceError, type AnyResult } from "../ipc-result.js";
import type {
  ChapterWorkflowState,
  ImportPreviewResult,
  IpcRequestMap,
  WorkspaceChapterInfo,
  WorkspaceInfo,
  WorkspaceSessionInfo,
  WorkspaceVolumeInfo,
} from "../ipc-contract.js";
import {
  addVolume,
  ChapterStateStore,
  inspectWorkspaceIntegrity,
  migrateLegacyEmptyManifest,
  nextVolumeId,
  createWorkspaceArchive,
  createWorkspaceSkeleton,
  maybeSnapshotWorkspace,
  recoverWorkspaceFileTransactions,
  volumeLabel,
  withChapterWorkspaceLock,
} from "@lightee/engine";
import type { ServiceContext } from "./service-context.js";
import type { WorkspaceRecord } from "../service-types.js";
import { workspaceIdFor, bookField, parseVolumeLabels } from "../workspace-scan.js";
import { CURRENT_SCHEMA_VERSION, SchemaVersionError, migrateWorkspaceSchema } from "../schema-migrations.js";

interface WorkspaceRegistryEntry {
  id: string;
  path: string;
  name: string;
  srcLang: string;
  tgtLang: string;
  openedAt: number;
}

interface WorkspaceRegistryFile {
  workspaces: WorkspaceRegistryEntry[];
}

interface WorkspaceSessionFile {
  workspaceId: string;
  chapterId: string;
  /** 上次编辑时光标所在段（可缺省——历史会话没有这个字段） */
  paragraphId?: string;
  savedAt: number;
}

export class WorkspaceService {
  /** 已打开的工作区。`ctx.workspace()` 的唯一后备存储 */
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private registryLoaded = false;
  private registry: WorkspaceRegistryEntry[] = [];

  constructor(
    private readonly ctx: ServiceContext,
    private readonly registryPath: string | null,
    /** 打开工作区时是否做自动快照（RH-21 / C-2）。仅真实应用开启 */
    private readonly autoSnapshot = false,
  ) {}

  // ===== 注入面转发（搬移过来的方法体保持零改动） =====
  private get engine(): ServiceContext["engine"] { return this.ctx.engine; }
  private pickDirectory(): Promise<string | null> { return this.ctx.pickDirectory(); }
  private log: ServiceContext["log"] = (level, message) => this.ctx.log(level, message);
  private emit: ServiceContext["emit"] = (type, payload) => this.ctx.emit(type, payload);
  private emitAgentStatus: ServiceContext["emitAgentStatus"] = (agent, status, message, provenance) => this.ctx.emitAgentStatus(agent, status, message, provenance);
  private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> { return this.ctx.enqueue(key, fn); }
  private trackWrite<T>(promise: Promise<T>): Promise<T> { return this.ctx.trackWrite(promise); }
  private get terminology() {
    return {
      startTerminologyWatcher: (workspace: WorkspaceRecord) => this.ctx.startTerminologyWatcher(workspace),
      stopTerminologyWatcher: (root: string) => this.ctx.stopTerminologyWatcher(root),
    };
  }
  private get structure() {
    return { pruneExpiredTrash: (root: string) => this.ctx.pruneExpiredTrash(root) };
  }
  private get workflow() {
    return { markBookReviewStale: (root: string, reason: string) => this.ctx.markBookReviewStale(root, reason) };
  }
  private get terminologyStatus() {
    return { markStale: (root: string, reason: string) => this.ctx.markTerminologyStale(root, reason) };
  }

  /** 遍历已打开的工作区（关窗排水、按 root 反查 id 用） */
  openWorkspaces(): IterableIterator<[string, WorkspaceRecord]> {
    return this.workspaces.entries();
  }

  workspace(workspaceId: string): WorkspaceRecord {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new ServiceError(errorFor("not_found", `Workspace not open: ${workspaceId}`));
    return workspace;
  }

  async loadRegistry(): Promise<void> {
    if (this.registryLoaded) return;
    this.registryLoaded = true;
    if (!this.registryPath) return;
    try {
      const raw = await readJson<unknown>(this.registryPath, { workspaces: [] });
      const entries = raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray((raw as { workspaces?: unknown }).workspaces)
        ? (raw as { workspaces: unknown[] }).workspaces
        : [];
      const valid: WorkspaceRegistryEntry[] = [];
      let cleaned = false;
      for (const entry of entries) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) { cleaned = true; continue; }
        const value = entry as Record<string, unknown>;
        if (typeof value.id !== "string" || typeof value.path !== "string" || typeof value.name !== "string" || typeof value.srcLang !== "string" || typeof value.tgtLang !== "string" || typeof value.openedAt !== "number") { cleaned = true; continue; }
        // 保留所有合法条目：目录已删除的由 registryInfo 标记 missing（可见且不可打开），
        // 不做静默过滤——否则用户的工作区会无声消失，且点进时直接报错
        valid.push({ id: value.id, path: value.path, name: value.name, srcLang: value.srcLang, tgtLang: value.tgtLang, openedAt: value.openedAt });
      }
      this.registry = valid;
      if (cleaned) await this.saveRegistry();
    } catch {
      this.registry = [];
    }
  }

  private async saveRegistry(): Promise<void> {
    if (!this.registryPath) return;
    await this.trackWrite(atomicWriteJson(this.registryPath, { workspaces: this.registry } satisfies WorkspaceRegistryFile));
  }

  async touchRegistry(info: WorkspaceInfo): Promise<void> {
    if (!this.registryPath) return;
    await this.loadRegistry();
    const entry: WorkspaceRegistryEntry = {
      id: info.id,
      path: info.path,
      name: info.name,
      srcLang: info.srcLang,
      tgtLang: info.tgtLang,
      openedAt: info.openedAt,
    };
    this.registry = [entry, ...this.registry.filter((candidate) => candidate.id !== entry.id && candidate.path !== entry.path)]
      .sort((a, b) => b.openedAt - a.openedAt);
    await this.saveRegistry();
  }

  private async workspaceVolumes(root: string, book: string): Promise<WorkspaceVolumeInfo[]> {
    const labels = parseVolumeLabels(book);
    const manifest = await readJson<{ chapters?: Array<{ id?: unknown; title?: unknown; volume?: unknown }> }>(join(root, "source", "manifest.json"), {});
    const chaptersByVolume = new Map<string, WorkspaceChapterInfo[]>();
    let chapterStates: Record<string, { state?: ChapterWorkflowState }> = {};
    try {
      const snapshot = await new ChapterStateStore(root).readSnapshot();
      chapterStates = snapshot.chapters;
    } catch {
      // A malformed or absent workflow snapshot must not hide the source tree.
    }
    const chapterInfo = (id: string, title: string): WorkspaceChapterInfo => ({ id, title, state: chapterStates[id]?.state });
    for (const chapter of manifest.chapters ?? []) {
      if (typeof chapter.id !== "string" || typeof chapter.title !== "string") continue;
      const volumeId = typeof chapter.volume === "string" && chapter.volume ? chapter.volume : "v01";
      const chapters = chaptersByVolume.get(volumeId) ?? [];
      chapters.push(chapterInfo(chapter.id, chapter.title));
      chaptersByVolume.set(volumeId, chapters);
    }

    try {
      const sourceEntries = await readdir(join(root, "source"), { withFileTypes: true });
      for (const entry of sourceEntries) {
        if (entry.isDirectory() && /^v\d+$/.test(entry.name) && !labels.has(entry.name)) labels.set(entry.name, entry.name);
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }

    for (const volumeId of chaptersByVolume.keys()) {
      if (!labels.has(volumeId)) labels.set(volumeId, volumeId);
    }
    if (labels.size === 0 && chaptersByVolume.size > 0) labels.set("v01", "第一卷");

    const volumes: WorkspaceVolumeInfo[] = [];
    for (const [id, label] of labels) {
      let chapters = chaptersByVolume.get(id) ?? [];
      if (chapters.length === 0) {
        try {
          const files = (await readdir(join(root, "source", id), { withFileTypes: true }))
            .filter((entry) => entry.isFile() && /^ch\d{3}\.md$/.test(entry.name))
            .sort((a, b) => a.name.localeCompare(b.name));
          chapters = await Promise.all(files.map(async (entry) => {
            const content = await readText(join(root, "source", id, entry.name));
            const chapterId = entry.name.slice(0, -3);
            return chapterInfo(chapterId, /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? chapterId);
          }));
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
        }
      }
      volumes.push({ id, label, chapters });
    }
    return volumes;
  }

  async workspaceInfo(root: string, openedAt = Date.now()): Promise<WorkspaceInfo> {
    const book = await readText(join(root, "book.yaml"));
    const name = bookField(book, "name", "");
    // 没有 book.yaml（readText 对 ENOENT 回空串）或它没写 name——两种情形都是
    // 「这个目录还不是工作区」。notAWorkspace 把这个判断留在唯一知道它的这一层：
    // 界面据此给出「在这里新建」的出路，而不是靠比对错误文案猜。
    if (!name) throw new ServiceError(errorFor("invalid_request", "这个目录还不是 Lightee 工作区（缺少 book.yaml）", false, { notAWorkspace: true }));
    const srcLang = bookField(book, "srcLang", "ja");
    const tgtLang = bookField(book, "tgtLang", "zh");
    const integrity = await inspectWorkspaceIntegrity({ root });
    if (!integrity.valid) {
      const first = integrity.errors[0]!;
      throw new ServiceError(errorFor("conflict", `工作区文件系统无效 [${first.code}] ${first.path}: ${first.message}`, false, {
        integrity: {
          valid: integrity.valid,
          errors: integrity.errors.map((entry) => ({ code: entry.code, path: entry.path, message: entry.message })),
          warnings: integrity.warnings.map((entry) => ({ code: entry.code, path: entry.path, message: entry.message })),
        },
      }));
    }
    const volumes = await this.workspaceVolumes(root, book);
    const chapterOwners = new Map<string, string>();
    for (const volume of volumes) {
      for (const chapter of volume.chapters) {
        const previousVolume = chapterOwners.get(chapter.id);
        if (previousVolume) {
          throw new ServiceError(errorFor(
            "conflict",
            `工作区包含重复章节 ID ${chapter.id}（${previousVolume}、${volume.id}）；为防止跨卷覆盖，已禁止打开`,
            false,
            { chapterId: chapter.id, volumeIds: [previousVolume, volume.id] },
          ));
        }
        chapterOwners.set(chapter.id, volume.id);
      }
    }
    return {
      id: workspaceIdFor(root),
      path: root,
      name,
      srcLang,
      tgtLang,
      openedAt,
      status: "ready",
      volumes,
    };
  }

  private async registryInfo(entry: WorkspaceRegistryEntry): Promise<WorkspaceInfo> {
    if (!(await exists(entry.path))) {
      return { ...entry, status: "missing", error: "工作区目录不存在", volumes: [] };
    }
    try {
      const metadata = await stat(entry.path);
      if (!metadata.isDirectory()) return { ...entry, status: "invalid", error: "工作区路径不是目录", volumes: [] };
      await withChapterWorkspaceLock(entry.path, () => recoverWorkspaceFileTransactions(entry.path));
      const book = await readText(join(entry.path, "book.yaml"));
      await migrateLegacyEmptyManifest({ root: entry.path }, bookField(book, "name", entry.name));
      return await this.workspaceInfo(entry.path, entry.openedAt);
    } catch (error) {
      return { ...entry, status: "invalid", error: error instanceof Error ? error.message : "工作区 metadata 无效", volumes: [] };
    }
  }

  async listWorkspaces(): Promise<AnyResult> {
    await this.loadRegistry();
    if (!this.registryPath) return success([...this.workspaces.values()].map((workspace) => workspace.info));
    const infos = await Promise.all(this.registry.map((entry) => this.registryInfo(entry)));
    // M-4：按 registry 差量维护，不再无条件 clear()。
    // 一次临时的 integrity 失败（book.yaml 正被外部编辑等）不应让已打开的工作区变成 not_found——
    // 那会把「这个文件当前有问题」变成「这个工作区不存在」，后续所有命令都报错。
    const listed = new Set(infos.map((info) => info.id));
    for (const [workspaceId, workspace] of [...this.workspaces]) {
      if (listed.has(workspaceId)) continue;
      this.terminology.stopTerminologyWatcher(workspace.root);
      this.workspaces.delete(workspaceId);
    }
    for (const info of infos) {
      if (info.status === "ready") {
        // RH-20 / B-2：**不在这里启动术语 watcher**。此前列表会给书架上每一本 ready 工作区
        // 都起一个 250ms 轮询；实测 300 章 × 10 本时，应用完全空闲也持续占用约 88% 单核。
        // watcher 只跟随「显式打开」的工作区（workspace.open / workspace.create 启动，
        // workspace.close 停止）——用户没在看的书不需要被实时监视。
        this.workspaces.set(info.id, { info, root: info.path });
      }
      // 非 ready 且此前已打开：保留原 record（含旧 info），等下次 list 恢复
    }
    return success(infos);
  }

  /**
   * 「上次编辑」= 所有工作区里 **savedAt 最大**的那份有效会话。
   *
   * 从前按工作区 openedAt 排序、返回第一个有会话文件的——那是「最近打开的
   * 工作区里的旧会话」：在 A 里编辑之后仅仅**打开过** B，B 的陈年会话就会赢。
   * 作者实测撞上的正是它的孪生形态：新工作区一次会话都没写过（写入点当时只有
   * 侧栏点击一处），读取便一路穿透到旧工作区。
   *
   * 指向已不存在章节的会话一并作废（重导入会重排章节 id）：拿它渲染出来的是
   * 一张预览两栏全空的卡，点进去又落到第一章——处处对不上「上次编辑」四个字。
   */
  async readWorkspaceSession(): Promise<AnyResult> {
    await this.loadRegistry();
    const entries = this.registryPath
      ? this.registry
      : [...this.workspaces.values()].map((workspace) => ({ ...workspace.info }));
    let latest: WorkspaceSessionFile | null = null;
    for (const entry of entries) {
      const session = await readJson<WorkspaceSessionFile | null>(join(entry.path, "state", "session.json"), null);
      if (!session || session.workspaceId !== entry.id || typeof session.chapterId !== "string" || typeof session.savedAt !== "number") continue;
      if (latest && latest.savedAt >= session.savedAt) continue;
      const manifest = await readJson<{ chapters?: Array<{ id?: string }> } | null>(join(entry.path, "source", "manifest.json"), null);
      if (!manifest?.chapters?.some((chapter) => chapter.id === session.chapterId)) continue;
      latest = session;
    }
    return success(latest satisfies WorkspaceSessionInfo | null);
  }

  async writeWorkspaceSession(request: IpcRequestMap["workspace.session.write"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    const path = join(workspace.root, "state", "session.json");
    return this.trackWrite(this.enqueue(`${workspace.root}:session`, async () => {
      // 段落位置的合并语义：打开章节的那次写入不带 paragraphId（人还没编辑），
      // 若同一章已有记录的位置，保留它——「打开看了一眼」不该抹掉「上次编辑到哪」。
      // 换章或显式带位置的写入照常覆盖。
      let paragraphId = request.paragraphId;
      if (!paragraphId) {
        const previous = await readJson<WorkspaceSessionFile | null>(path, null);
        if (previous && previous.workspaceId === request.workspaceId && previous.chapterId === request.chapterId) paragraphId = previous.paragraphId;
      }
      const session: WorkspaceSessionFile = { workspaceId: request.workspaceId, chapterId: request.chapterId, ...(paragraphId ? { paragraphId } : {}), savedAt: Date.now() };
      await atomicWriteJson(path, session);
      return success(session satisfies WorkspaceSessionInfo);
    }));
  }

  async openWorkspace(request: IpcRequestMap["workspace.open"]): Promise<AnyResult> {
    await this.loadRegistry();
    const root = resolve(request.path);
    if (!(await exists(root))) throw new ServiceError(errorFor("not_found", "Workspace path does not exist"));
    const metadata = await stat(root);
    if (!metadata.isDirectory()) throw new ServiceError(errorFor("invalid_request", "Workspace path is not a directory"));
    await withChapterWorkspaceLock(root, () => recoverWorkspaceFileTransactions(root));
    // C-3：schema 迁移必须在**任何**读写之前。版本过新时一个字节都不写，直接拒绝——
    // 让旧版本把新格式回写成旧格式，比拒绝打开严重得多。
    try {
      await migrateWorkspaceSchema(root);
    } catch (error) {
      if (error instanceof SchemaVersionError) throw new ServiceError(errorFor("conflict", error.message, false, { schemaVersion: error.found, supported: CURRENT_SCHEMA_VERSION }));
      throw error;
    }
    const book = await readText(join(root, "book.yaml"));
    await migrateLegacyEmptyManifest({ root }, bookField(book, "name", "未命名工作区"));
    const info = await this.workspaceInfo(root);
    const opened = { ...info, openedAt: Date.now() };
    const workspace = { info: opened, root };
    this.workspaces.set(opened.id, workspace);
    await this.structure.pruneExpiredTrash(root);
    // C-2：机会式自动快照。不 await——备份是尽力而为，绝不拖慢「打开工作区」这个
    // 用户每次都要等的动作；失败也只记一行日志（maybeSnapshotWorkspace 内部吞异常）。
    //
    // 但**必须** trackWrite：否则关窗/退出会在打包中途结束进程，留下一个截断的 zip，
    // 而截断的备份比没有备份更坏——用户以为有，真要恢复时才发现没有。
    //
    // 默认关闭（`autoSnapshot`）：测试与库用法打开一个工作区不该在用户目录里生出 zip。
    // 更要命的是它会跑在测试清理**之后**，把刚被删掉的目录又建回来（实测 ENOTEMPTY）。
    if (this.autoSnapshot) {
      void this.trackWrite(maybeSnapshotWorkspace(root).then((made) => {
        if (made) this.log("info", `workspace snapshot created for ${opened.id}`);
      }));
    }
    this.terminology.startTerminologyWatcher(workspace);
    await this.touchRegistry(opened);
    this.emit("workspace.changed", { action: "opened", workspaceId: opened.id });
    return success(opened);
  }

  /**
   * 手动导出工作区归档（RH-21 / C-2）。目标目录走原生选择器——renderer 不该拿到
   * 任意文件系统路径，写盘位置必须由用户在系统对话框里亲自选。
   */
  async exportArchive(request: IpcRequestMap["workspace.exportArchive"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    const directory = await this.pickDirectory();
    if (!directory) return success({ status: "cancelled" as const, workspaceId: request.workspaceId });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeName = (workspace.info.name || "lightee-workspace").replace(/[\/:*?"<>|]/g, "_");
    const target = join(directory, `${safeName}-${stamp}.zip`);
    return this.trackWrite(this.enqueue(`${resolve(workspace.root)}:archive`, async () => {
      await createWorkspaceArchive(workspace.root, target);
      const bytes = await stat(target).then((s) => s.size).catch(() => 0);
      this.log("info", `workspace archive exported ${request.workspaceId} bytes=${bytes}`);
      return success({ status: "exported" as const, workspaceId: request.workspaceId, path: target, bytes });
    }));
  }

  async createWorkspace(request: IpcRequestMap["workspace.create"]): Promise<AnyResult> {
    await this.loadRegistry();
    const root = resolve(request.path);
    // 目录骨架 / book.yaml / manifest / 内置规则播种全部由 engine 的骨架函数负责——
    // 它是创建工作区的唯一实现。这里只做 Electron 独有的副作用：注册表、监听器、事件。
    await createWorkspaceSkeleton(root, { name: request.name, srcLang: request.srcLang, tgtLang: request.tgtLang });
    const info = await this.workspaceInfo(root);
    const created = { ...info, openedAt: Date.now() };
    const workspace = { info: created, root };
    this.workspaces.set(created.id, workspace);
    this.terminology.startTerminologyWatcher(workspace);
    await this.touchRegistry(created);
    this.emit("workspace.changed", { action: "created", workspaceId: created.id });
    return success(created);
  }

  /**
   * 从最近列表移除一个条目。
   *
   * `loadRegistry` 刻意保留目录已消失的条目（标 `missing`）——静默过滤会让用户的工作区
   * 无声消失。但「看得见」不等于「删不掉」：没有出口，失效条目就永远堆在列表里。
   * 这条命令是那个出口，且**只动注册表，不碰磁盘**——目录还在的工作区移除后
   * 仍可通过「打开」重新加回来。
   */
  async forgetWorkspace(request: IpcRequestMap["workspace.forget"]): Promise<AnyResult> {
    await this.loadRegistry();
    const before = this.registry.length;
    this.registry = this.registry.filter((entry) => entry.id !== request.workspaceId);
    if (this.registry.length === before) return failure(errorFor("not_found", `最近列表里没有这个工作区：${request.workspaceId}`, false));
    await this.saveRegistry();
    // 已打开的同 id 工作区一并释放，否则它还在内存里、还能被别的命令操作
    const open = this.workspaces.get(request.workspaceId);
    if (open) {
      this.terminology.stopTerminologyWatcher(open.root);
      this.workspaces.delete(request.workspaceId);
    }
    this.emit("workspace.changed", { action: "closed", workspaceId: request.workspaceId });
    return this.listWorkspaces();
  }

  async closeWorkspace(request: IpcRequestMap["workspace.close"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    this.terminology.stopTerminologyWatcher(workspace.root);
    this.workspaces.delete(request.workspaceId);
    this.emit("workspace.changed", { action: "closed", workspaceId: request.workspaceId });
    return success({ workspaceId: request.workspaceId });
  }

  async previewImport(request: IpcRequestMap["import.preview"]): Promise<AnyResult> {
    if (!(await exists(request.sourcePath))) throw new ServiceError(errorFor("not_found", "Import source does not exist"));
    if (this.engine?.previewImport) {
      try {
        const preview = await this.engine.previewImport(request.sourcePath);
        const extension = `.${preview.ext.toLowerCase()}`;
        const format: ImportPreviewResult["format"] = extension === ".txt" ? "txt" : extension === ".md" ? "md" : extension === ".epub" ? "epub" : "unknown";
        return success({
          sourcePath: request.sourcePath,
          format,
          chapters: preview.chapters,
          ...(preview.volumes ? { volumes: preview.volumes } : {}),
        });
      } catch (cause) {
        throw new ServiceError(errorFor("invalid_request", cause instanceof Error ? cause.message : "Import preview failed"));
      }
    }
    const extension = extname(request.sourcePath).toLowerCase();
    const format: ImportPreviewResult["format"] = extension === ".txt" ? "txt" : extension === ".md" ? "md" : extension === ".epub" ? "epub" : "unknown";
    if (format === "epub") return success({ sourcePath: request.sourcePath, format, chapters: [] });
    const raw = await readText(request.sourcePath);
    const headings = raw.split(/\r?\n/).filter((line) => /^(?:#\s+|第[一二三四五六七八九十百千万0-9０-９]+[章話]|序章|終章|プロローグ|エピローグ)/.test(line.trim()));
    return success({
      sourcePath: request.sourcePath,
      format,
      chapters: (headings.length > 0 ? headings : ["本文"]).map((title) => ({ title: title.trim(), charCount: raw.length, needsManualConfirm: headings.length === 0 })),
    });
  }

  async importText(request: IpcRequestMap["import.text"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    const tempDir = join(workspace.root, ".agents", "tmp");
    const manifestPath = join(workspace.root, "source", "manifest.json");
    const hadManifest = await exists(manifestPath);
    const tempPath = join(tempDir, `paste-${randomUUID()}.txt`);
    await mkdir(tempDir, { recursive: true });
    await writeFile(tempPath, request.text, "utf8");
    try {
      const imported = await this.importRun({ workspaceId: request.workspaceId, sourcePath: tempPath, volumeId: request.volumeId, target: request.target });
      if (imported.ok && !hadManifest) {
        const manifest = await readJson<Record<string, unknown>>(manifestPath, {});
        await atomicWriteJson(manifestPath, { ...manifest, book: workspace.info.name });
      }
      return imported;
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  async importRun(request: IpcRequestMap["import.run"]): Promise<AnyResult> {
    const engine = this.engine;
    if (!engine) return failure(errorFor("unsupported", "Engine wiring is unavailable", false));
    const workspace = this.workspace(request.workspaceId);
    const key = `${workspace.root}:metadata`;
    return this.trackWrite(this.enqueue(key, () => withChapterWorkspaceLock(workspace.root, async () => {
      try {
        this.emitAgentStatus("import", "running", request.sourcePath, { workspaceId: request.workspaceId, operation: "import" });
        // target 归一化：volumeId 为兼容别名；"new" 强制新建卷；"<volId>" 指定已有卷
        let volumeId = request.volumeId;
        if (request.target?.volume) {
          if (request.target.volume === "new") {
            volumeId = await nextVolumeId({ root: workspace.root });
            await addVolume({ root: workspace.root }, volumeId, volumeLabel(volumeId));
          } else if (request.target.volume !== "auto") {
            volumeId = request.target.volume;
          }
        }
        const manifest = await engine.importFile(request.sourcePath, { root: workspace.root }, { volumeId });
        await this.workflow.markBookReviewStale(workspace.root, "导入了新的原文章节");
        // 新章节的候选术语从未被抽取过。术语状态是工作区级标志，而 translateRun 的
        // 前置门禁就是它——不失效的话新章节能直接绕过术语确认开翻。
        await this.terminologyStatus.markStale(workspace.root, "导入了新的原文章节");
        const refreshed = await this.workspaceInfo(workspace.root, workspace.info.openedAt);
        workspace.info = refreshed;
        await this.touchRegistry(refreshed);
        this.emit("workspace.changed", { action: "structure", workspaceId: request.workspaceId, reason: "imported" });
        this.emitAgentStatus("import", "done", `${manifest.chapters.length} 章`, { workspaceId: request.workspaceId, operation: "import" });
        return success({ status: "queued" as const, workspaceId: request.workspaceId, chapters: manifest.chapters.length });
      } catch (cause) {
        this.emitAgentStatus("import", "failed", cause instanceof Error ? cause.message : "导入失败", { workspaceId: request.workspaceId, operation: "import" });
        throw new ServiceError(errorFor("internal", cause instanceof Error ? cause.message : "导入失败", false));
      }
    })));
  }
}
