export interface WorkspaceChapter {
  id: string;
  title: string;
  state?: import("../../../shared/ipc-contract.js").ChapterWorkflowState;
}

export interface WorkspaceVolume {
  id: string;
  name: string;
  chapters: WorkspaceChapter[];
}

export interface WorkspaceRecord {
  id: string;
  path: string;
  name: string;
  srcLang: string;
  tgtLang: string;
  openedAt: number;
  status?: "ready" | "missing" | "invalid";
  error?: string;
  volumes: WorkspaceVolume[];
}

export interface WorkspaceSession {
  workspaceId: string;
  chapterId: string;
  /** 上次编辑时光标所在段；恢复时直接落回这一段 */
  paragraphId?: string;
  savedAt: number;
}

export type WorkspaceOpenOutcome =
  | { ok: true; workspace: WorkspaceRecord }
  /** notAWorkspace：目录本身没问题，只是还没建过工作区——界面据此给出「在这里新建」 */
  | { ok: false; message: string; notAWorkspace?: boolean };

export interface EditorSettingsRecord {
  fontSize: number;
  sourceColor: "dim" | "soft" | "faint";
  paragraphGap: "tight" | "natural" | "loose";
  termHighlight: "highlight" | "underline" | "none";
  sourceLink: boolean;
  focusCenter: boolean;
  cursorAnimate: boolean;
  cursorBlink: boolean;
  cursorShape: "block" | "beam" | "underline";
  sourceEditable: boolean;
}

export type EditorSettingsOutcome =
  | { ok: true; settings: EditorSettingsRecord; revision: number }
  | { ok: false; message: string };

export type EditorSettingsWriteOutcome =
  | { ok: true; revision: number }
  | { ok: false; message: string };

export interface WorkspaceStoreAdapter {
  list(): Promise<WorkspaceRecord[]>;
  open(path: string): Promise<WorkspaceOpenOutcome>;
  create(request: { path: string; name: string; srcLang?: string; tgtLang?: string }): Promise<WorkspaceOpenOutcome>;
  renameVolume(workspaceId: string, volumeId: string, name: string): Promise<boolean>;
  renameChapter(workspaceId: string, volumeId: string, chapterId: string, title: string): Promise<boolean>;
  loadChapter(workspaceId: string, chapterId: string): Promise<ChapterLoadOutcome>;
  saveDraft(workspaceId: string, chapterId: string, baseRevision: number, paragraphs: Array<{ id: string; source: string; translation: string }>): Promise<SaveDraftOutcome>;
  queryTerms(workspaceId: string, chapterId?: string): Promise<Array<{ ja: string; zh: string }>>;
  readEditorSettings(workspaceId: string): Promise<EditorSettingsOutcome>;
  writeEditorSetting(workspaceId: string, key: string, value: number | string, baseRevision: number): Promise<EditorSettingsWriteOutcome>;
  createChapter(workspaceId: string, volumeId: string, title?: string, afterChapterId?: string, source?: string): Promise<ChapterCreateOutcome>;
  saveSourceCorrection(workspaceId: string, chapterId: string, baseRevision: number, source: string): Promise<SourceCorrectionOutcome>;
  deleteChapter(workspaceId: string, volumeId: string, chapterId: string): Promise<ChapterDeleteOutcome>;
  restoreChapter(workspaceId: string, trashId: string): Promise<RestoreOutcome>;
  moveChapter(workspaceId: string, chapterId: string, targetVolumeId: string, afterChapterId?: string): Promise<MoveOutcome>;
  deleteVolume(workspaceId: string, volumeId: string): Promise<VolumeDeleteOutcome>;
  restoreVolume(workspaceId: string, trashId: string): Promise<RestoreOutcome>;
  importText(workspaceId: string, text: string, target?: { volume?: "auto" | "new" | string }): Promise<ImportOutcome>;
  session(): Promise<WorkspaceSession | null>;
  setSession(session: WorkspaceSession | null): Promise<void>;
  pickDirectory(): Promise<string | null>;
}

export type ChapterCreateOutcome =
  | { ok: true; chapterId: string; volumeId: string; title: string }
  | { ok: false; message: string };

export type ChapterDeleteOutcome =
  | { ok: true; trashId: string; title: string; chapterId: string; volumeId: string }
  | { ok: false; message: string };

export interface ChapterContent {
  chapterId: string;
  revision: number;
  paragraphs: Array<{ id: string; source: string; translation: string }>;
  sourceCorrectionRevision: number;
}

export type ChapterLoadOutcome =
  | { ok: true; content: ChapterContent }
  | { ok: false; message: string };

export type SaveDraftOutcome =
  | { ok: true; revision: number; savedAt: number }
  | { ok: false; message: string; code: "conflict" | "failed"; revision?: number };

export type SourceCorrectionOutcome =
  | { ok: true; revision: number; source: string }
  | { ok: false; message: string; code: "conflict" | "failed"; revision?: number };

export type RestoreOutcome =
  | { ok: true; chapterId?: string; volumeId: string; chapterCount?: number }
  | { ok: false; message: string };

export type MoveOutcome =
  | { ok: true; volumeId: string; order: string[] }
  | { ok: false; message: string };

export type VolumeDeleteOutcome =
  | { ok: true; trashId: string; volumeId: string; chapterCount: number }
  | { ok: false; message: string };

export type ImportOutcome =
  | { ok: true; chapters: number }
  | { ok: false; message: string };

function workspaceIdFor(path: string): string {
  let hash = 0;
  for (let index = 0; index < path.length; index += 1) {
    hash = (hash * 31 + path.charCodeAt(index)) | 0;
  }
  return `ws-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function seededWorkspaces(): WorkspaceRecord[] {
  return [
    {
      id: "ws-b001",
      path: "C:/books/amane",
      name: "雨中的天使",
      srcLang: "ja",
      tgtLang: "zh",
      openedAt: 1_752_000_000_000,
      volumes: [
        { id: "v01", name: "第一卷", chapters: [
          { id: "ch001", title: "雨中的天使", state: "approved" },
          { id: "ch002", title: "公园的相遇", state: "translated" },
          { id: "ch003", title: "雨伞", state: "translating" },
        ] },
        { id: "v02", name: "第二卷", chapters: [
          { id: "ch004", title: "新学期", state: "ready" },
          { id: "ch005", title: "午餐时间", state: "imported" },
        ] },
      ],
    },
    {
      id: "ws-b002",
      path: "C:/books/tensei",
      name: "转生剑士",
      srcLang: "ja",
      tgtLang: "zh",
      openedAt: 1_751_800_000_000,
      volumes: [
        { id: "v01", name: "第一卷", chapters: [
          { id: "ch001", title: "死亡与转生", state: "approved" },
          { id: "ch002", title: "边境小镇", state: "ready" },
        ] },
      ],
    },
    {
      id: "ws-b003",
      path: "C:/books/isekai",
      name: "异世界咖啡馆",
      srcLang: "ja",
      tgtLang: "zh",
      openedAt: 1_751_600_000_000,
      volumes: [
        { id: "v01", name: "第一卷", chapters: [
          { id: "ch001", title: "开业", state: "imported" }
        ] },
      ],
    },
  ];
}

export class MemoryWorkspaceAdapter implements WorkspaceStoreAdapter {
  private workspaces: WorkspaceRecord[] = seededWorkspaces();
  private sessionState: WorkspaceSession | null = {
    workspaceId: "ws-b001",
    chapterId: "ch002",
    savedAt: 1_752_100_000_000,
  };
  nextPickedPath: string | null = null;
  openCallCount = 0;

  async list(): Promise<WorkspaceRecord[]> {
    return [...this.workspaces].sort((a, b) => b.openedAt - a.openedAt);
  }

  async open(path: string): Promise<WorkspaceOpenOutcome> {
    this.openCallCount += 1;
    const existing = this.workspaces.find((workspace) => workspace.path === path);
    if (existing) {
      existing.openedAt = Date.now();
      return { ok: true, workspace: existing };
    }
    const id = workspaceIdFor(path);
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? "未命名工作区";
    const workspace: WorkspaceRecord = {
      id,
      path,
      name,
      srcLang: "ja",
      tgtLang: "zh",
      openedAt: Date.now(),
      volumes: [{ id: "v01", name: "第一卷", chapters: [{ id: "ch001", title: "本文", state: "ready" }] }],
    };
    this.workspaces.push(workspace);
    return { ok: true, workspace };
  }

  async create(request: { path: string; name: string; srcLang?: string; tgtLang?: string }): Promise<WorkspaceOpenOutcome> {
    if (!request.path.trim()) return { ok: false, message: "目录不能为空" };
    if (!request.name.trim()) return { ok: false, message: "工作区名称不能为空" };
    if (this.workspaces.some((workspace) => workspace.path === request.path)) {
      return { ok: false, message: "该目录已在工作区列表中" };
    }
    const workspace: WorkspaceRecord = {
      id: workspaceIdFor(request.path),
      path: request.path,
      name: request.name.trim(),
      srcLang: request.srcLang ?? "ja",
      tgtLang: request.tgtLang ?? "zh",
      openedAt: Date.now(),
      volumes: [{ id: "v01", name: "第一卷", chapters: [{ id: "ch001", title: "本文", state: "ready" }] }],
    };
    this.workspaces.push(workspace);
    return { ok: true, workspace };
  }

  async renameVolume(workspaceId: string, volumeId: string, name: string): Promise<boolean> {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    const volume = workspace?.volumes.find((candidate) => candidate.id === volumeId);
    if (!volume || !name.trim()) return false;
    volume.name = name.trim();
    return true;
  }

  async renameChapter(workspaceId: string, volumeId: string, chapterId: string, title: string): Promise<boolean> {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    const chapter = workspace?.volumes.find((candidate) => candidate.id === volumeId)?.chapters.find((candidate) => candidate.id === chapterId);
    if (!chapter || !title.trim()) return false;
    chapter.title = title.trim();
    return true;
  }

  async loadChapter(workspaceId: string, chapterId: string): Promise<ChapterLoadOutcome> {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    const chapter = workspace?.volumes.flatMap((volume) => volume.chapters).find((candidate) => candidate.id === chapterId);
    if (!chapter) return { ok: false, message: "章节不存在" };
    return {
      ok: true,
      content: { chapterId, revision: 1, paragraphs: [{ id: "p0001", source: chapter.title, translation: chapter.title }], sourceCorrectionRevision: 0 },
    };
  }

  async saveDraft(workspaceId: string, chapterId: string, baseRevision: number, paragraphs: Array<{ id: string; source: string; translation: string }>): Promise<SaveDraftOutcome> {
    return { ok: true, revision: baseRevision + 1, savedAt: Date.now() };
  }

  async saveSourceCorrection(workspaceId: string, chapterId: string, baseRevision: number, source: string): Promise<SourceCorrectionOutcome> {
    return { ok: true, revision: baseRevision + 1, source };
  }

  async queryTerms(workspaceId: string, chapterId?: string): Promise<Array<{ ja: string; zh: string }>> {
    return [
      { ja: "少年", zh: "少年" },
      { ja: "少女", zh: "少女" },
      { ja: "天使", zh: "天使" },
    ];
  }

  async readEditorSettings(workspaceId: string): Promise<EditorSettingsOutcome> {
    return {
      ok: true,
      settings: { fontSize: 18, sourceColor: "faint", paragraphGap: "natural", termHighlight: "highlight", sourceLink: true, focusCenter: true, cursorAnimate: true, cursorBlink: false, cursorShape: "block", sourceEditable: false },
      revision: 0,
    };
  }

  async writeEditorSetting(workspaceId: string, key: string, value: number | string, baseRevision: number): Promise<EditorSettingsWriteOutcome> {
    return { ok: true, revision: baseRevision + 1 };
  }

  async createChapter(workspaceId: string, volumeId: string, title = "新章节", afterChapterId?: string, source?: string): Promise<ChapterCreateOutcome> {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) return { ok: false, message: "工作区不存在" };
    let volume = workspace.volumes.find((candidate) => candidate.id === volumeId);
    if (!volume) {
      volume = { id: volumeId, name: `第${volumeId.replace(/^v/, "")}卷`, chapters: [] };
      workspace.volumes.push(volume);
    }
    const usedIds = workspace.volumes.flatMap((candidate) => candidate.chapters).map((chapter) => chapter.id);
    const max = usedIds.reduce((value, id) => {
      const match = /^ch(\d+)$/.exec(id);
      return match ? Math.max(value, Number.parseInt(match[1]!, 10)) : value;
    }, 0);
    const chapterId = `ch${String(max + 1).padStart(3, "0")}`;
    const chapter = { id: chapterId, title: title.trim() || "新章节", state: "imported" as const };
    if (afterChapterId) {
      const idx = volume.chapters.findIndex((chapter) => chapter.id === afterChapterId);
      volume.chapters.splice(idx + 1, 0, chapter);
    } else {
      volume.chapters.push(chapter);
    }
    return { ok: true, chapterId, volumeId, title: chapter.title };
  }

  async deleteChapter(workspaceId: string, volumeId: string, chapterId: string): Promise<ChapterDeleteOutcome> {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    const volume = workspace?.volumes.find((candidate) => candidate.id === volumeId);
    const idx = volume?.chapters.findIndex((chapter) => chapter.id === chapterId) ?? -1;
    if (!volume || idx < 0) return { ok: false, message: "章节不存在" };
    const removed = volume.chapters.splice(idx, 1)[0]!;
    return { ok: true, trashId: `tr-${chapterId}`, title: removed.title, chapterId, volumeId };
  }

  async restoreChapter(workspaceId: string, trashId: string): Promise<RestoreOutcome> {
    return { ok: true, volumeId: "v01" };
  }

  async moveChapter(workspaceId: string, chapterId: string, targetVolumeId: string, afterChapterId?: string, atStart?: boolean): Promise<MoveOutcome> {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) return { ok: false, message: "工作区不存在" };
    let from: { vol: WorkspaceVolume; idx: number } | null = null;
    for (const vol of workspace.volumes) {
      const idx = vol.chapters.findIndex((chapter) => chapter.id === chapterId);
      if (idx >= 0) { from = { vol, idx }; break; }
    }
    if (!from) return { ok: false, message: "章节不存在" };
    let target = workspace.volumes.find((candidate) => candidate.id === targetVolumeId);
    if (!target) { target = { id: targetVolumeId, name: `第${targetVolumeId.replace(/^v/, "")}卷`, chapters: [] }; workspace.volumes.push(target); }
    const chapter = from.vol.chapters.splice(from.idx, 1)[0]!;
    if (atStart) {
      target.chapters.unshift(chapter);
    } else if (afterChapterId) {
      const idx = target.chapters.findIndex((chapter) => chapter.id === afterChapterId);
      target.chapters.splice(idx + 1, 0, chapter);
    } else {
      target.chapters.push(chapter);
    }
    return { ok: true, volumeId: targetVolumeId, order: target.chapters.map((chapter) => chapter.id) };
  }

  async deleteVolume(workspaceId: string, volumeId: string): Promise<VolumeDeleteOutcome> {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    const idx = workspace?.volumes.findIndex((candidate) => candidate.id === volumeId) ?? -1;
    if (!workspace || idx < 0) return { ok: false, message: "卷不存在" };
    const removed = workspace.volumes.splice(idx, 1)[0]!;
    return { ok: true, trashId: `tr-${volumeId}`, volumeId, chapterCount: removed.chapters.length };
  }

  async restoreVolume(workspaceId: string, trashId: string): Promise<RestoreOutcome> {
    return { ok: true, volumeId: "v01" };
  }

  async importText(workspaceId: string, text: string, target?: { volume?: "auto" | "new" | string }): Promise<ImportOutcome> {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) return { ok: false, message: "工作区不存在" };
    return { ok: true, chapters: 1 };
  }

  async session(): Promise<WorkspaceSession | null> {
    return this.sessionState ? { ...this.sessionState } : null;
  }

  async setSession(session: WorkspaceSession | null): Promise<void> {
    this.sessionState = session ? { ...session } : null;
  }

  async pickDirectory(): Promise<string | null> {
    return this.nextPickedPath;
  }
}

function fromIpcWorkspace(info: import("../../../shared/ipc-contract").WorkspaceInfo): WorkspaceRecord {
  return {
    id: info.id,
    path: info.path,
    name: info.name,
    srcLang: info.srcLang,
    tgtLang: info.tgtLang,
    openedAt: info.openedAt,
    status: info.status,
    error: info.error,
    volumes: info.volumes.map((volume) => ({
      id: volume.id,
      name: volume.label,
      chapters: volume.chapters.map((chapter) => ({ id: chapter.id, title: chapter.title, state: chapter.state })),
    })),
  };
}

export class IpcWorkspaceAdapter implements WorkspaceStoreAdapter {
  private readonly api: import("../../../shared/ipc-contract").LighteeApi;

  constructor() {
    if (!window.lightee) throw new Error("Lightee IPC bridge is unavailable");
    this.api = window.lightee;
  }

  async list(): Promise<WorkspaceRecord[]> {
    const result = await this.api.invoke("workspace.list", {});
    return result.ok ? result.value.map(fromIpcWorkspace) : [];
  }

  async open(path: string): Promise<WorkspaceOpenOutcome> {
    const result = await this.api.invoke("workspace.open", { path });
    if (!result.ok) {
      const details = result.error.details;
      const notAWorkspace = Boolean(details && typeof details === "object" && !Array.isArray(details) && (details as Record<string, unknown>).notAWorkspace);
      return { ok: false, message: result.error.message, notAWorkspace };
    }
    return { ok: true, workspace: fromIpcWorkspace(result.value) };
  }

  async create(request: { path: string; name: string; srcLang?: string; tgtLang?: string }): Promise<WorkspaceOpenOutcome> {
    const result = await this.api.invoke("workspace.create", request);
    if (!result.ok) return { ok: false, message: result.error.message };
    return { ok: true, workspace: fromIpcWorkspace(result.value) };
  }

  async renameVolume(workspaceId: string, volumeId: string, name: string): Promise<boolean> {
    const result = await this.api.invoke("workspace.renameVolume", { workspaceId, volumeId, name });
    return result.ok;
  }

  async renameChapter(workspaceId: string, volumeId: string, chapterId: string, title: string): Promise<boolean> {
    const result = await this.api.invoke("workspace.renameChapter", { workspaceId, volumeId, chapterId, title });
    return result.ok;
  }

  async loadChapter(workspaceId: string, chapterId: string): Promise<ChapterLoadOutcome> {
    const result = await this.api.invoke("chapter.load", { workspaceId, chapterId });
    if (!result.ok) return { ok: false, message: result.error.message };
    return {
      ok: true,
      content: {
        chapterId: result.value.chapterId,
        revision: result.value.revision,
        paragraphs: result.value.paragraphs.map((paragraph) => ({
          id: paragraph.id,
          source: paragraph.source,
          translation: paragraph.translation,
        })),
        sourceCorrectionRevision: result.value.sourceCorrection?.revision ?? 0,
      },
    };
  }

  async saveDraft(workspaceId: string, chapterId: string, baseRevision: number, paragraphs: Array<{ id: string; source: string; translation: string }>): Promise<SaveDraftOutcome> {
    const result = await this.api.invoke("chapter.saveDraft", { workspaceId, chapterId, baseRevision, paragraphs });
    if (!result.ok) {
      const details = result.error.details as { currentRevision?: unknown } | undefined;
      return {
        ok: false,
        message: result.error.message,
        code: result.error.code === "conflict" ? "conflict" : "failed",
        ...(typeof details?.currentRevision === "number" ? { revision: details.currentRevision } : {}),
      };
    }
    return { ok: true, revision: result.value.revision, savedAt: result.value.savedAt };
  }

  async queryTerms(workspaceId: string, chapterId?: string): Promise<Array<{ ja: string; zh: string }>> {
    const result = await this.api.invoke("terms.query", { workspaceId, chapterId });
    if (!result.ok) return [];
    return result.value.items.map((term) => ({ ja: term.ja ?? "", zh: term.zh ?? "" }));
  }

  async readEditorSettings(workspaceId: string): Promise<EditorSettingsOutcome> {
    const result = await this.api.invoke("settings.read", { workspaceId });
    if (!result.ok) return { ok: false, message: result.error.message };
    const values = result.value.values as Record<string, unknown>;
    const editor = (values.editor ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      settings: {
        fontSize: typeof editor.fontSize === "number" ? editor.fontSize : 18,
        sourceColor: (["dim", "soft", "faint"] as const).includes(editor.sourceColor as never) ? editor.sourceColor as EditorSettingsRecord["sourceColor"] : "faint",
        paragraphGap: (["tight", "natural", "loose"] as const).includes(editor.paragraphGap as never) ? editor.paragraphGap as EditorSettingsRecord["paragraphGap"] : "natural",
        termHighlight: (["highlight", "underline", "none"] as const).includes(editor.termHighlight as never) ? editor.termHighlight as EditorSettingsRecord["termHighlight"] : "highlight",
        sourceLink: editor.sourceLink !== false,
        focusCenter: editor.focusCenter !== false,
        cursorAnimate: editor.cursorAnimate !== false,
        cursorBlink: editor.cursorBlink !== false,
        cursorShape: (["block", "beam", "underline"] as const).includes(editor.cursorShape as never) ? editor.cursorShape as EditorSettingsRecord["cursorShape"] : "block",
        sourceEditable: editor.sourceEditable === true,
      },
      revision: result.value.revision,
    };
  }

  async writeEditorSetting(workspaceId: string, key: string, value: number | string, baseRevision: number): Promise<EditorSettingsWriteOutcome> {
    const result = await this.api.invoke("settings.write", { workspaceId, baseRevision, key: `editor.${key}`, value });
    if (!result.ok) return { ok: false, message: result.error.message };
    return { ok: true, revision: result.value.revision };
  }

  async createChapter(workspaceId: string, volumeId: string, title?: string, afterChapterId?: string, source?: string): Promise<ChapterCreateOutcome> {
    const result = await this.api.invoke("chapter.create", { workspaceId, volumeId, title, afterChapterId, source });
    if (!result.ok) return { ok: false, message: result.error.message };
    return { ok: true, chapterId: result.value.chapterId, volumeId: result.value.volumeId, title: result.value.title };
  }

  async saveSourceCorrection(workspaceId: string, chapterId: string, baseRevision: number, source: string): Promise<SourceCorrectionOutcome> {
    const result = await this.api.invoke("chapter.saveSourceCorrection", { workspaceId, chapterId, baseRevision, source });
    if (!result.ok) {
      const details = result.error.details as { currentRevision?: unknown } | undefined;
      return {
        ok: false,
        message: result.error.message,
        code: result.error.code === "conflict" ? "conflict" : "failed",
        ...(typeof details?.currentRevision === "number" ? { revision: details.currentRevision } : {}),
      };
    }
    return { ok: true, revision: result.value.revision, source: result.value.source };
  }

  async deleteChapter(workspaceId: string, volumeId: string, chapterId: string): Promise<ChapterDeleteOutcome> {
    const result = await this.api.invoke("chapter.delete", { workspaceId, volumeId, chapterId });
    if (!result.ok) return { ok: false, message: result.error.message };
    return { ok: true, trashId: result.value.trashId, title: result.value.title, chapterId: result.value.chapterId, volumeId: result.value.volumeId };
  }

  async restoreChapter(workspaceId: string, trashId: string): Promise<RestoreOutcome> {
    const result = await this.api.invoke("chapter.restore", { workspaceId, trashId });
    if (!result.ok) return { ok: false, message: result.error.message };
    return { ok: true, chapterId: result.value.chapterId, volumeId: result.value.volumeId };
  }

  async moveChapter(workspaceId: string, chapterId: string, targetVolumeId: string, afterChapterId?: string, atStart?: boolean): Promise<MoveOutcome> {
    const result = await this.api.invoke("chapter.move", { workspaceId, chapterId, targetVolumeId, afterChapterId, atStart });
    if (!result.ok) return { ok: false, message: result.error.message };
    return { ok: true, volumeId: result.value.volumeId, order: result.value.order };
  }

  async deleteVolume(workspaceId: string, volumeId: string): Promise<VolumeDeleteOutcome> {
    const result = await this.api.invoke("volume.delete", { workspaceId, volumeId });
    if (!result.ok) return { ok: false, message: result.error.message };
    return { ok: true, trashId: result.value.trashId, volumeId: result.value.volumeId, chapterCount: result.value.chapterCount };
  }

  async restoreVolume(workspaceId: string, trashId: string): Promise<RestoreOutcome> {
    const result = await this.api.invoke("volume.restore", { workspaceId, trashId });
    if (!result.ok) return { ok: false, message: result.error.message };
    return { ok: true, volumeId: result.value.volumeId, chapterCount: result.value.chapterCount };
  }

  async importText(workspaceId: string, text: string, target?: { volume?: "auto" | "new" | string }): Promise<ImportOutcome> {
    const result = await this.api.invoke("import.text", { workspaceId, text, target });
    if (!result.ok) return { ok: false, message: result.error.message };
    return { ok: true, chapters: result.value.chapters };
  }

  async session(): Promise<WorkspaceSession | null> {
    const result = await this.api.invoke("workspace.session.read", {});
    return result.ok ? result.value : null;
  }

  async setSession(session: WorkspaceSession | null): Promise<void> {
    if (!session) return;
    await this.api.invoke("workspace.session.write", session);
  }

  async pickDirectory(): Promise<string | null> {
    const result = await this.api.invoke("dialog.pickDirectory", {});
    return result.ok ? result.value.path : null;
  }
}
