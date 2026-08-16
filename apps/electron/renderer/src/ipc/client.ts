import type {
  IpcCommand,
  IpcEvent,
  IpcEventName,
  IpcRequestMap,
  IpcResponseMap,
  IpcResult,
  LighteeApi,
  ParagraphDraft,
} from "../../../shared/ipc-contract";
import type { DraftAdapter, DraftCheckpointOutcome, DraftSaveOutcome, SourceCorrectionAdapter } from "../editor/autosave";

export type { LighteeApi } from "../../../shared/ipc-contract";

export type SaveUiState = "saved" | "conflict" | "retryable" | "failed";

export function getIpcApi(): LighteeApi {
  if (!window.lightee) throw new Error("Lightee IPC bridge is unavailable");
  return window.lightee;
}

export function mapSaveResult(result: IpcResult<unknown>): SaveUiState {
  if (result.ok) return "saved";
  if (result.error.code === "conflict") return "conflict";
  if (result.error.retryable || result.error.code === "busy") return "retryable";
  return "failed";
}

/**
 * Real persistence adapter over the preload bridge (chapter.saveDraft / chapter.checkpoint).
 * Wired when window.lightee is available inside Electron; not exercised by the headless
 * prototype harness, whose IPC-service behavior is covered by shared unit tests.
 */
export class IpcDraftAdapter implements DraftAdapter {
  private readonly api: LighteeApi;

  constructor() {
    this.api = getIpcApi();
  }

  async saveDraft(request: {
    workspaceId: string;
    chapterId: string;
    baseRevision: number;
    paragraphs: ParagraphDraft[];
  }): Promise<DraftSaveOutcome> {
    const result = await this.api.invoke("chapter.saveDraft", request);
    if (result.ok) return { ok: true, revision: result.value.revision };
    if (result.error.code === "conflict") {
      const details = result.error.details as { currentRevision?: number } | undefined;
      return { ok: false, code: "conflict", revision: details?.currentRevision };
    }
    return { ok: false, code: "failed" };
  }

  async checkpoint(request: { workspaceId: string; chapterId: string; revision: number }): Promise<DraftCheckpointOutcome> {
    const result = await this.api.invoke("chapter.checkpoint", request);
    if (result.ok) return { ok: true, checkpointPath: result.value.checkpointPath };
    return { ok: false };
  }
}

export class IpcSourceCorrectionAdapter implements SourceCorrectionAdapter {
  private readonly api: LighteeApi;

  constructor() {
    this.api = getIpcApi();
  }

  async saveSourceCorrection(request: {
    workspaceId: string;
    chapterId: string;
    baseRevision: number;
    source: string;
  }): Promise<DraftSaveOutcome> {
    const result = await this.api.invoke("chapter.saveSourceCorrection", request);
    if (result.ok) return { ok: true, revision: result.value.revision };
    if (result.error.code === "conflict") {
      const details = result.error.details as { currentRevision?: number } | undefined;
      return { ok: false, code: "conflict", revision: details?.currentRevision };
    }
    return { ok: false, code: "failed" };
  }
}

export type TypedInvoke = <K extends IpcCommand>(
  command: K,
  payload: IpcRequestMap[K],
) => Promise<IpcResult<IpcResponseMap[K]>>;

export type TypedEventHandler<K extends IpcEventName> = (event: IpcEvent<K>) => void;
