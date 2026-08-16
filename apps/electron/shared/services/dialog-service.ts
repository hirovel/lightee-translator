/**
 * 原生对话框服务（RH-11 从 `ipc-service.ts` 搬出，零行为变更）。
 * 目录/文件选择器由宿主注入；未注入时返回 null（测试与 headless 运行）。
 */
import { errorFor, failure, success, type AnyResult } from "../ipc-result.js";
import type { ServiceContext } from "./service-context.js";

export class DialogService {
  constructor(private readonly ctx: ServiceContext) {}

  private pickDirectory(title?: string): Promise<string | null> { return this.ctx.pickDirectory(title); }
  private pickFile(): Promise<string | null> { return this.ctx.pickFile(); }

  /**
   * `title` 一直写在契约里，却在这一层被丢掉——不管为什么开这个选择器，
   * 弹出来的标题都是「选择工作区目录」。选导出位置时它说的是错的。
   */
  async pickDirectoryRequest(request?: { title?: string }): Promise<AnyResult> {
    try {
      const path = await this.pickDirectory(request?.title);
      return success({ path });
    } catch (cause) {
      return failure(errorFor("internal", cause instanceof Error ? cause.message : "Directory picker failed", true));
    }
  }

  async pickFileRequest(): Promise<AnyResult> {
    try {
      const path = await this.pickFile();
      return success({ path });
    } catch (cause) {
      return failure(errorFor("internal", cause instanceof Error ? cause.message : "File picker failed", true));
    }
  }

}
