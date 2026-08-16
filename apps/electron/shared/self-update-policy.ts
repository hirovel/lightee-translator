import { isPackageManagerInstall } from "./package-manager-install.js";

/**
 * 「这次运行要不要让 electron-updater 自己去检查更新」——此前这个判定分散在
 * `main.js` 里的好几个 if，读的时候要跳着看才拼得出全貌，改的时候也容易漏掉一支。
 * 收成一个纯函数，四条跳过路径各自留痕（调用方据此写 AppLog，运行时能看出
 * 「这次为什么没有查更新」，而不是只看到「没查」这一个事实）。
 *
 * 四条路径：
 * - 未打包（开发模式跑源码）：本来就没有可更新的安装产物。
 * - `LIGHTEE_DISABLE_UPDATES=1`：手动关闭，供诊断/演练使用。
 * - 包管理器安装（Scoop 等）：更新权归包管理器，见 package-manager-install.ts。
 * - portable 版：没有安装上下文，electron-updater 在 Windows 上的更新方式是
 *   下载 setup.exe 并运行——portable 用户手上根本没有那个安装器认识的落脚点，
 *   查了也更新不了，只会白跑一次网络请求。用 electron-builder 在 portable
 *   运行时注入的 `PORTABLE_EXECUTABLE_DIR` 环境变量识别。
 */
export type SelfUpdateSkipReason = "not-packaged" | "disabled-by-env" | "package-manager-install" | "portable-build";

export interface SelfUpdateContext {
  isPackaged: boolean;
  env: Record<string, string | undefined>;
  execPath: string;
}

export type SelfUpdateDecision = { update: true } | { update: false; reason: SelfUpdateSkipReason };

export function evaluateSelfUpdate(ctx: SelfUpdateContext): SelfUpdateDecision {
  if (!ctx.isPackaged) return { update: false, reason: "not-packaged" };
  if (ctx.env.LIGHTEE_DISABLE_UPDATES === "1") return { update: false, reason: "disabled-by-env" };
  if (ctx.env.PORTABLE_EXECUTABLE_DIR) return { update: false, reason: "portable-build" };
  if (isPackageManagerInstall(ctx.execPath)) return { update: false, reason: "package-manager-install" };
  return { update: true };
}
