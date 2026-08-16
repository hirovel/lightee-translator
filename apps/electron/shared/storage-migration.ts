/**
 * 0.10 存储迁移：把散在两处的旧数据收进唯一数据根。
 *
 *   ~/.lightee/                  → <root>/config、<root>/history
 *   %APPDATA%\lightee-electron\  → <root>/logs（其余是 Chromium 运行时，不搬）
 *
 * 三条纪律，都是从 2026-08-16 那次误删换来的：
 *
 *  1. **先复制，后改名，绝不删。** 全部复制成功才把旧目录改名成 `<旧名>.migrated`，
 *     原件一个字节都不动。中途断电或失败就当没发生过——下次启动重来一遍。
 *  2. **幂等。** 新根的 config 里只要已经有东西，直接跳过：迁移只在「新根还是空的」
 *     这一种状态下才动手。
 *  3. **只记形状。** 日志里只有路径与文件数，没有任何配置值、密钥、正文。
 *
 * 本模块**不依赖 Electron**，路径全部由调用方传入，测试可以完整驱动。
 */
import fs from "node:fs";
import path from "node:path";
import type { LighteePaths } from "./app-paths.js";

export interface MigrationInput {
  /** 目标：新的唯一数据根及其子路径 */
  paths: LighteePaths;
  /** 旧址一：`~/.lightee`（配置与调用历史） */
  legacyHomeDir: string;
  /** 旧址二：`%APPDATA%\lightee-electron`（日志 + Chromium 运行时） */
  legacyUserDataDir: string;
}

export interface MigrationResult {
  /** 是否真的搬了东西 */
  migrated: boolean;
  /** 写进 AppLog 的行；只含路径与计数 */
  log: string[];
}

/** `~/.lightee` 里搬走的东西：文件名 → 目标目录取自 LighteePaths 的哪一项 */
const CONFIG_FILES = ["models.json", "auth.json", "workspaces.json"];

function copyFileIfPresent(from: string, to: string): boolean {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  // copyFileSync 而不是 rename：跨卷会失败，且我们本来就不打算移动原件。
  fs.copyFileSync(from, to);
  return true;
}

/** 目标已存在就加序号，绝不覆盖既有的 .migrated 备份 */
function retireDirectory(dir: string): string {
  let target = `${dir}.migrated`;
  for (let n = 2; fs.existsSync(target); n += 1) target = `${dir}.migrated-${n}`;
  fs.renameSync(dir, target);
  return target;
}

/** 新根的 config 里已经有配置 → 迁移做过了（或用户本来就是全新安装） */
function alreadyPopulated(paths: LighteePaths): boolean {
  return CONFIG_FILES.some((name) => fs.existsSync(path.join(paths.configDir, name)));
}

export function migrateLegacyStorage(input: MigrationInput): MigrationResult {
  const { paths, legacyHomeDir, legacyUserDataDir } = input;
  const log: string[] = [];
  let migrated = false;

  // ——— 一、~/.lightee → <root>/config + <root>/history ———
  if (alreadyPopulated(paths)) {
    // 什么都不做，也不记日志：绝大多数启动都走这条路。
  } else if (fs.existsSync(legacyHomeDir)) {
    try {
      let configCount = 0;
      for (const name of CONFIG_FILES) {
        if (copyFileIfPresent(path.join(legacyHomeDir, name), path.join(paths.configDir, name))) configCount += 1;
      }
      // models.json 的历史备份（models.json.bak 等）一并带走，与配置放在一起。
      for (const name of fs.readdirSync(legacyHomeDir)) {
        if (!name.endsWith(".bak")) continue;
        if (copyFileIfPresent(path.join(legacyHomeDir, name), path.join(paths.configDir, name))) configCount += 1;
      }

      // 调用历史含轮转份：llm-history.jsonl、llm-history.jsonl.1、.2 ……
      let historyCount = 0;
      for (const name of fs.readdirSync(legacyHomeDir)) {
        if (!name.startsWith("llm-history.jsonl")) continue;
        if (copyFileIfPresent(path.join(legacyHomeDir, name), path.join(paths.historyDir, name))) historyCount += 1;
      }

      const retired = retireDirectory(legacyHomeDir);
      migrated = true;
      log.push(`storage-migration: ${legacyHomeDir} → ${paths.root} config=${configCount} history=${historyCount}; 旧目录留存于 ${retired}`);
    } catch (error) {
      // 失败就原样留着，下次启动再来。绝不在这条路径上删任何东西。
      log.push(`storage-migration: ${legacyHomeDir} 迁移未完成，旧目录保持原样：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ——— 二、%APPDATA%\lightee-electron\logs → <root>/logs ———
  //
  // 这个目录里除 logs 之外全是 Chromium 自建的运行时缓存（Cache / GPUCache /
  // Local Storage / Network …），新根启动后会重新长出来，不必搬。整个目录改名收尾，
  // 于是磁盘上只剩「程序一个、数据一个」。
  const legacyLogs = path.join(legacyUserDataDir, "logs");
  if (fs.existsSync(legacyUserDataDir) && path.resolve(legacyUserDataDir) !== path.resolve(paths.root)) {
    try {
      // 更早的版本把工作区书架放在 Electron profile 根下。`~/.lightee` 那一段没搬到的话
      // （比如用户从没升到过带 ~/.lightee 的版本），最后在这里兜住。
      const legacyRegistry = path.join(legacyUserDataDir, "workspaces.json");
      if (!fs.existsSync(paths.workspaceRegistryPath) && fs.existsSync(legacyRegistry)) {
        copyFileIfPresent(legacyRegistry, paths.workspaceRegistryPath);
        log.push(`storage-migration: ${legacyRegistry} → ${paths.workspaceRegistryPath}`);
      }

      let logCount = 0;
      if (fs.existsSync(legacyLogs)) {
        for (const name of fs.readdirSync(legacyLogs)) {
          const target = path.join(paths.logsDir, name);
          // 同名日志已在新根里 → 不覆盖（新根的那份才是当前运行写的）
          if (fs.existsSync(target)) continue;
          if (copyFileIfPresent(path.join(legacyLogs, name), target)) logCount += 1;
        }
      }
      const retired = retireDirectory(legacyUserDataDir);
      migrated = true;
      log.push(`storage-migration: ${legacyUserDataDir} → ${paths.logsDir} logs=${logCount}; 旧目录留存于 ${retired}`);
    } catch (error) {
      log.push(`storage-migration: ${legacyUserDataDir} 迁移未完成，旧目录保持原样：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { migrated, log };
}
