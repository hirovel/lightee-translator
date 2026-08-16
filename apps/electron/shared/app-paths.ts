/**
 * Lightee 在磁盘上的全部落点，一处算清。
 *
 * 0.10 之前数据散在三个地方：`~/.lightee`（配置与历史）、`%APPDATA%\lightee-electron`
 * （日志与 Chromium 运行时）、以及安装目录。用户要彻底清干净得知道三条路径，而清理逻辑
 * 每多一处就多一个删错的机会——这不是洁癖问题，是事故面问题。
 *
 * 现在只有一个数据根：`%APPDATA%\Lightee`。与 VS Code（`%APPDATA%\Code`）、
 * Obsidian（`%APPDATA%\obsidian`）同形态，也是 Electron 的 userData 默认位置族。
 * 程序本体在 `%LOCALAPPDATA%\Programs\Lightee`，按 Windows 惯例与数据分离。
 *
 * **本模块不依赖 Electron**：路径是纯计算，根目录由调用方传入。主进程传
 * `app.getPath("userData")`，测试传临时目录，两边走的是同一份代码。
 */
import { join } from "node:path";

/**
 * 数据根的目录名。
 *
 * 刻意**不**取 package.json 的 `name`（那是 `lightee-electron`，Electron 的默认取值），
 * 也不改 `name` 本身——改包名会牵动 asar 布局与整条构建链，爆炸半径远大于收益。
 * 主进程用 `app.setPath("userData", …)` 显式指定，一行达成同样效果。
 */
export const LIGHTEE_DATA_DIR_NAME = "Lightee";

/** `%APPDATA%\Lightee`。参数是 Electron 的 `appData`（Windows 上即 `%APPDATA%`）。 */
export function lighteeUserDataRoot(appDataDir: string): string {
  return join(appDataDir, LIGHTEE_DATA_DIR_NAME);
}

export interface LighteePaths {
  /** 数据根本身。卸载时带 --delete-app-data 清的就是它。 */
  root: string;
  /** 配置：models.json / auth.json / workspaces.json */
  configDir: string;
  modelsPath: string;
  authPath: string;
  /** 工作区书架。译稿本体在用户自选目录里，这里只存清单。 */
  workspaceRegistryPath: string;
  /** LLM 调用历史（含轮转份 .1/.2/…） */
  historyDir: string;
  historyFile: string;
  /** 运维日志（AppLog，已脱敏） */
  logsDir: string;
}

/** 由数据根推出全部子路径。Chromium 运行时目录由 Electron 自己管，不在此列。 */
export function lighteePaths(root: string): LighteePaths {
  const configDir = join(root, "config");
  const historyDir = join(root, "history");
  return {
    root,
    configDir,
    modelsPath: join(configDir, "models.json"),
    authPath: join(configDir, "auth.json"),
    workspaceRegistryPath: join(configDir, "workspaces.json"),
    historyDir,
    historyFile: join(historyDir, "llm-history.jsonl"),
    logsDir: join(root, "logs"),
  };
}
