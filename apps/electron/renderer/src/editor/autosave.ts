import type { ParagraphDraft } from "../../../shared/ipc-contract";

export type SavePhase = "idle" | "modified" | "saving" | "saved" | "failed" | "conflict";

export interface AutosaveState {
  phase: SavePhase;
  baseRevision: number;
  lastSavedAt: number | null;
  checkpointPath: string | null;
  error: string | null;
}

export interface DraftSaveResult {
  ok: true;
  revision: number;
}

export interface DraftSaveFailure {
  ok: false;
  code: "conflict" | "failed";
  revision?: number;
}

export type DraftSaveOutcome = DraftSaveResult | DraftSaveFailure;

export interface DraftCheckpointResult {
  ok: true;
  checkpointPath: string;
}

export type DraftCheckpointOutcome = DraftCheckpointResult | { ok: false };

export interface DraftAdapter {
  saveDraft(request: {
    workspaceId: string;
    chapterId: string;
    baseRevision: number;
    paragraphs: ParagraphDraft[];
  }): Promise<DraftSaveOutcome>;
  checkpoint(request: { workspaceId: string; chapterId: string; revision: number }): Promise<DraftCheckpointOutcome>;
}

export interface AutosaveControllerOptions {
  adapter: DraftAdapter;
  workspaceId: string;
  chapterId: string;
  delayMs?: number;
  onStateChange?: (state: AutosaveState) => void;
}

const initialState = (baseRevision: number): AutosaveState => ({
  phase: "idle",
  baseRevision,
  lastSavedAt: null,
  checkpointPath: null,
  error: null,
});

export class AutosaveController {
  private readonly adapter: DraftAdapter;
  private readonly workspaceId: string;
  private readonly chapterId: string;
  private readonly delayMs: number;
  private readonly onStateChange?: (state: AutosaveState) => void;
  private state: AutosaveState;
  private draft: ParagraphDraft[] | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private flushCycle: Promise<void> | null = null;
  private drainRequested = false;
  private autoEnabled = true;

  constructor(options: AutosaveControllerOptions) {
    this.adapter = options.adapter;
    this.workspaceId = options.workspaceId;
    this.chapterId = options.chapterId;
    this.delayMs = options.delayMs ?? 600;
    this.onStateChange = options.onStateChange;
    this.state = initialState(0);
  }

  getState(): AutosaveState {
    return { ...this.state };
  }

  setEnabled(enabled: boolean): void {
    this.autoEnabled = enabled;
    if (!enabled && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.draft = null;
      this.patch({ phase: "idle", error: null });
    } else if (enabled && this.draft && this.state.phase === "modified") {
      this.scheduleFlush();
    }
  }

  markModified(paragraphs: ParagraphDraft[]): void {
    this.generation += 1;
    this.draft = paragraphs.map((paragraph) => ({ ...paragraph }));
    if (this.state.phase === "saving") return; // completion handler reschedules
    this.patch({ phase: "modified", error: null });
    this.scheduleFlush();
  }

  async flush(): Promise<void> {
    return this.requestFlush(true);
  }

  private async requestFlush(drain: boolean): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (drain) this.drainRequested = true;
    if (this.flushCycle) return this.flushCycle;
    this.flushCycle = this.runFlushCycle();
    try {
      await this.flushCycle;
    } finally {
      this.flushCycle = null;
      this.drainRequested = false;
    }
  }

  private async runFlushCycle(): Promise<void> {
    while (this.draft && this.state.phase !== "idle" && this.state.phase !== "saved") {
      const request = {
        workspaceId: this.workspaceId,
        chapterId: this.chapterId,
        baseRevision: this.state.baseRevision,
        paragraphs: this.draft,
      };
      const generation = this.generation;
      this.patch({ phase: "saving", error: null });
      this.inFlight = (async () => {
        const outcome = await this.adapter.saveDraft(request);
        if (outcome.ok) {
          if (generation === this.generation) this.draft = null;
          this.patch({ phase: "saved", baseRevision: outcome.revision, lastSavedAt: Date.now(), error: null });
        } else if (outcome.code === "conflict") {
          this.patch({ phase: "conflict", error: `服务端修订 ${outcome.revision ?? "未知"}` });
        } else {
          this.patch({ phase: "failed", error: "保存失败" });
        }
      })();
      try {
        await this.inFlight;
      } finally {
        this.inFlight = null;
      }
      if (this.state.phase === "failed" || this.state.phase === "conflict") return;
      if (generation !== this.generation) {
        this.patch({ phase: "modified" });
        if (this.drainRequested) continue;
        this.scheduleFlush();
      }
      return;
    }
  }

  async saveNow(checkpoint = false): Promise<AutosaveState> {
    await this.flush();
    if (checkpoint && this.state.phase === "saved") {
      const outcome = await this.adapter.checkpoint({
        workspaceId: this.workspaceId,
        chapterId: this.chapterId,
        revision: this.state.baseRevision,
      });
      if (outcome.ok) this.patch({ checkpointPath: outcome.checkpointPath });
    }
    return this.getState();
  }

  reset(baseRevision = this.state.baseRevision): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.draft = null;
    this.patch({ ...initialState(baseRevision), lastSavedAt: this.state.lastSavedAt });
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleFlush(): void {
    if (!this.autoEnabled) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.requestFlush(false);
    }, this.delayMs);
  }

  private patch(patch: Partial<AutosaveState>): void {
    this.state = { ...this.state, ...patch };
    this.onStateChange?.(this.getState());
  }
}

export interface SourceCorrectionAdapter {
  saveSourceCorrection(request: {
    workspaceId: string;
    chapterId: string;
    baseRevision: number;
    source: string;
  }): Promise<DraftSaveOutcome>;
}

export class SourceCorrectionController {
  private readonly adapter: SourceCorrectionAdapter;
  private readonly workspaceId: string;
  private readonly chapterId: string;
  private readonly delayMs: number;
  private readonly onStateChange?: (state: AutosaveState) => void;
  private state = initialState(0);
  private source: string | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private flushCycle: Promise<void> | null = null;
  private drainRequested = false;
  private autoEnabled = true;

  constructor(options: {
    adapter: SourceCorrectionAdapter;
    workspaceId: string;
    chapterId: string;
    delayMs?: number;
    onStateChange?: (state: AutosaveState) => void;
  }) {
    this.adapter = options.adapter;
    this.workspaceId = options.workspaceId;
    this.chapterId = options.chapterId;
    this.delayMs = options.delayMs ?? 600;
    this.onStateChange = options.onStateChange;
  }

  getState(): AutosaveState {
    return { ...this.state };
  }

  setEnabled(enabled: boolean): void {
    this.autoEnabled = enabled;
    if (!enabled && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    } else if (enabled && this.source !== null && this.state.phase === "modified") {
      this.scheduleFlush();
    }
  }

  markModified(source: string): void {
    this.generation += 1;
    this.source = source;
    this.patch({ phase: "modified", error: null });
    this.scheduleFlush();
  }

  async flush(): Promise<void> {
    return this.requestFlush(true);
  }

  private async requestFlush(drain: boolean): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (drain) this.drainRequested = true;
    if (this.flushCycle) return this.flushCycle;
    this.flushCycle = this.runFlushCycle();
    try {
      await this.flushCycle;
    } finally {
      this.flushCycle = null;
      this.drainRequested = false;
    }
  }

  private async runFlushCycle(): Promise<void> {
    while (this.source !== null && this.state.phase !== "idle" && this.state.phase !== "saved") {
      const source = this.source;
      const generation = this.generation;
      this.patch({ phase: "saving", error: null });
      this.inFlight = (async () => {
        const outcome = await this.adapter.saveSourceCorrection({
          workspaceId: this.workspaceId,
          chapterId: this.chapterId,
          baseRevision: this.state.baseRevision,
          source,
        });
        if (outcome.ok) {
          if (generation === this.generation) this.source = null;
          this.patch({ phase: "saved", baseRevision: outcome.revision, lastSavedAt: Date.now(), error: null });
        } else if (outcome.code === "conflict") {
          this.patch({ phase: "conflict", error: `原文修订 ${outcome.revision ?? "未知"}` });
        } else {
          this.patch({ phase: "failed", error: "原文保存失败" });
        }
      })();
      try {
        await this.inFlight;
      } finally {
        this.inFlight = null;
      }
      if (this.state.phase === "failed" || this.state.phase === "conflict") return;
      if (this.generation !== generation) {
        this.patch({ phase: "modified" });
        if (this.drainRequested) continue;
        this.scheduleFlush();
      }
      return;
    }
  }

  async saveNow(): Promise<AutosaveState> {
    await this.flush();
    return this.getState();
  }

  reset(baseRevision = this.state.baseRevision): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.source = null;
    this.patch({ ...initialState(baseRevision), lastSavedAt: this.state.lastSavedAt });
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleFlush(): void {
    if (!this.autoEnabled) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.requestFlush(false);
    }, this.delayMs);
  }

  private patch(patch: Partial<AutosaveState>): void {
    this.state = { ...this.state, ...patch };
    this.onStateChange?.(this.getState());
  }
}

export class MemorySourceCorrectionAdapter implements SourceCorrectionAdapter {
  revision = 0;
  source = "";
  saveCallCount = 0;
  latencyMs = 0;
  failNext = false;
  conflictNext = false;

  async saveSourceCorrection(request: {
    workspaceId: string;
    chapterId: string;
    baseRevision: number;
    source: string;
  }): Promise<DraftSaveOutcome> {
    this.saveCallCount += 1;
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    if (this.failNext) {
      this.failNext = false;
      return { ok: false, code: "failed" };
    }
    if (this.conflictNext || request.baseRevision !== this.revision) {
      this.conflictNext = false;
      return { ok: false, code: "conflict", revision: this.revision };
    }
    this.source = request.source;
    this.revision += 1;
    return { ok: true, revision: this.revision };
  }
}

export class MemoryDraftAdapter implements DraftAdapter {
  private revision = 0;
  private readonly drafts = new Map<string, ParagraphDraft[]>();
  latencyMs = 0;
  failNext = false;
  conflictNext = false;
  saveCallCount = 0;
  checkpointCallCount = 0;

  constructor(
    private readonly workspaceId: string,
    private readonly chapterId: string,
  ) {}

  async saveDraft(request: {
    workspaceId: string;
    chapterId: string;
    baseRevision: number;
    paragraphs: ParagraphDraft[];
  }): Promise<DraftSaveOutcome> {
    this.saveCallCount += 1;
    await sleep(this.latencyMs);
    if (request.workspaceId !== this.workspaceId || request.chapterId !== this.chapterId) return { ok: false, code: "failed" };
    if (this.failNext) {
      this.failNext = false;
      return { ok: false, code: "failed" };
    }
    if (this.conflictNext || request.baseRevision !== this.revision) {
      this.conflictNext = false;
      return { ok: false, code: "conflict", revision: this.revision };
    }
    this.revision += 1;
    this.drafts.set(request.chapterId, request.paragraphs.map((paragraph) => ({ ...paragraph })));
    return { ok: true, revision: this.revision };
  }

  async checkpoint(request: { workspaceId: string; chapterId: string; revision: number }): Promise<DraftCheckpointOutcome> {
    this.checkpointCallCount += 1;
    await sleep(this.latencyMs);
    if (request.revision !== this.revision) return { ok: false };
    return { ok: true, checkpointPath: `state/checkpoints/${request.chapterId}.json` };
  }

  getRevision(): number {
    return this.revision;
  }

  snapshot(chapterId = this.chapterId): ParagraphDraft[] | undefined {
    return this.drafts.get(chapterId);
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}
