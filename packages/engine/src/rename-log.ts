/**
 * 改名事件日志（TP-4 飞行中改名补扫的数据源）。
 *
 * 三段时序保证的中段：作者在某章**飞行中**改了术语译法，追溯改名扫的是
 * 已落盘的章——正在飞的这一章还没落盘，扫不到；等它落盘，里面就是旧译名。
 * 谁也不知道哪些章正在飞（D9 续跑无状态），所以由**落盘方**负责补扫：
 * 章管线结束后查「我开工之后发生过哪些改名」，逐条对本章重放。
 *
 * 日志只记事件（词与时刻），不记扫描结果——重放时按当时的档案现场重算占位。
 */
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { atomicWriteFile, readJson, withFileMutationQueue } from "@lightee/core/atomic-fs";
import type { Workspace } from "./workspace.ts";

export interface RenameEvent {
  ja: string;
  oldZh: string;
  newZh: string;
  at: number;
}

/** 只保留最近这么多条：补扫窗口是「一章的飞行时长」，几百条早已覆盖 */
const LOG_LIMIT = 300;

export function renameLogPath(ws: Workspace): string {
  return join(ws.root, "state", "rename-log.json");
}

export async function appendRenameEvent(ws: Workspace, event: RenameEvent): Promise<void> {
  const path = renameLogPath(ws);
  await withFileMutationQueue(path, async () => {
    const current = await readRenameLog(ws);
    const next = [...current, event].slice(-LOG_LIMIT);
    await mkdir(join(ws.root, "state"), { recursive: true });
    await atomicWriteFile(path, `${JSON.stringify({ version: 1, events: next }, null, 2)}\n`);
  });
}

async function readRenameLog(ws: Workspace): Promise<RenameEvent[]> {
  const raw = await readJson<{ events?: RenameEvent[] }>(renameLogPath(ws)).catch(() => null);
  if (!Array.isArray(raw?.events)) return [];
  return raw.events.filter((event): event is RenameEvent =>
    Boolean(event) && typeof event.oldZh === "string" && typeof event.newZh === "string" && typeof event.at === "number");
}

/** 时刻 `since` 之后的改名事件，按发生顺序。链式改名（A→B→C）要按序重放才能追上 */
export async function readRenameEventsSince(ws: Workspace, since: number): Promise<RenameEvent[]> {
  return (await readRenameLog(ws)).filter((event) => event.at >= since);
}
