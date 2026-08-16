import type { ChapterSnapshot, IpcResult, LighteeApi } from "../../../shared/ipc-contract";
import type { WorkbenchContext } from "../workspace/workbench-context.js";
import { getIpcApi } from "../ipc/client.js";

export interface ChapterAdapter {
  load(context: WorkbenchContext): Promise<ChapterSnapshot>;
}

export class IpcChapterAdapter implements ChapterAdapter {
  private readonly api: LighteeApi;

  constructor(api = getIpcApi()) {
    this.api = api;
  }

  async load(context: WorkbenchContext): Promise<ChapterSnapshot> {
    const result: IpcResult<ChapterSnapshot> = await this.api.invoke("chapter.load", {
      workspaceId: context.workspaceId,
      chapterId: context.chapterId,
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }
}
