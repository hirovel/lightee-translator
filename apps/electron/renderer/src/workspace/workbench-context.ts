import type { WorkspaceRecord } from "./workspace-store.js";

export interface WorkbenchContext {
  workspaceId: string;
  workspaceName: string;
  chapterId: string;
  chapterTitle: string;
  volumeId: string;
  volumeName: string;
  srcLang: string;
  tgtLang: string;
}

export type WorkbenchContextListener = (context: WorkbenchContext | null) => void;

export function contextForChapter(workspace: WorkspaceRecord, chapterId: string | null): WorkbenchContext | null {
  if (!chapterId) return null;
  for (const volume of workspace.volumes) {
    const chapter = volume.chapters.find((candidate) => candidate.id === chapterId);
    if (chapter) {
      return {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        volumeId: volume.id,
        volumeName: volume.name,
        srcLang: workspace.srcLang,
        tgtLang: workspace.tgtLang,
      };
    }
  }
  return null;
}

export class WorkbenchContextStore {
  private current: WorkbenchContext | null = null;
  private readonly listeners = new Set<WorkbenchContextListener>();

  get(): WorkbenchContext | null {
    return this.current ? { ...this.current } : null;
  }

  set(context: WorkbenchContext | null): void {
    this.current = context ? { ...context } : null;
    const snapshot = this.get();
    for (const listener of this.listeners) listener(snapshot);
  }

  subscribe(listener: WorkbenchContextListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
