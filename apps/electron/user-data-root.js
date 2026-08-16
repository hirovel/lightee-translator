/**
 * 数据根落位 + 旧数据迁移。**必须是 main.js 的第一个 import。**
 *
 * ESM 会按 import 顺序求值模块体，所以顺序在这里是语义的一部分：
 *
 *   user-data-root.js   ← 本模块：定下 userData 在哪
 *   single-instance.js  ← 单实例锁**存放在 userData 里**，设晚了就会出现
 *                          新旧两份应用各拿各的锁、互不排斥
 *   main-ipc.js         ← 构造 AppLog、读工作区注册表，此时路径必须已经定好
 *
 * 迁移放在单实例锁之后：第二个实例在那里就退出了，不会两个进程同时搬。
 */
import { app } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import { LIGHTEE_DATA_DIR_NAME, lighteePaths } from "./dist-main/shared/app-paths.js";
import { setLighteeDataRoot } from "./dist-main/shared/lightee-config.js";
import { migrateLegacyStorage } from "./dist-main/shared/storage-migration.js";

/**
 * `--user-data-dir` 是隔离验收与截图脚本用来把整个 profile 挪进临时目录的手段。
 * `app.setPath("userData", …)` 会盖掉它——那等于让本该隔离的运行去读写用户的真实数据，
 * 正是要防的那一类事故。给了开关就不改根。
 */
const isolatedProfile = app.commandLine.hasSwitch("user-data-dir");

if (!isolatedProfile) {
  // 目录名取 "Lightee" 而不是 package.json 的 name（"lightee-electron"，Electron 的默认取值）。
  // 改包名会牵动 asar 布局与整条构建链，这里一行显式指定即可，爆炸半径小得多。
  app.setPath("userData", join(app.getPath("appData"), LIGHTEE_DATA_DIR_NAME));
}

export const dataRoot = app.getPath("userData");
export const paths = lighteePaths(dataRoot);

// 库模块不再自带 `~/.lightee` 这种默认值：路径是政策，由主进程一处决定。
setLighteeDataRoot(dataRoot);

/** 迁移日志，等 AppLog 构造好之后由 main.js 落盘（此刻 AppLog 还不存在）。 */
export const migrationLog = [];

/**
 * 迁移只在真实运行里做。隔离 profile 或显式指定了配置目录时一律跳过——
 * 那些运行的整个用意就是别碰用户的真实数据，而迁移恰恰要去读 `~/.lightee`。
 */
export function runStorageMigration() {
  if (isolatedProfile || process.env.LIGHTEE_CONFIG_DIR?.trim() || process.env.LIGHTEE_WORKSPACE_REGISTRY) return;
  try {
    const result = migrateLegacyStorage({
      paths,
      legacyHomeDir: join(homedir(), ".lightee"),
      legacyUserDataDir: join(app.getPath("appData"), "lightee-electron"),
    });
    migrationLog.push(...result.log);
  } catch (error) {
    // 迁移失败绝不能挡住启动：旧数据原样留着，下次启动再试。
    migrationLog.push(`storage-migration: 跳过（${error instanceof Error ? error.message : String(error)}）`);
  }
}
