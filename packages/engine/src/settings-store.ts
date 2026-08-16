/**
 * settings-store —— 设置持久化（workspace config.json）。
 *
 * 设计（E2）:
 *   TUI /settings 显示全部设置 · /set <key> <value> 修改并持久化
 *   白名单键（防错拼）: quoteStyle / translation.* / agents.*.thinking 等
 *   默认值与 config.ts 一致（quoteStyle=zh · contextWindow=131072 · concurrency=3）
 */

import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "@lightee/core/atomic-fs";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Workspace } from "./workspace.ts";

// ===== 白名单（防错拼；点路径）=====
const ALLOWED_KEYS: Record<string, (v: string) => unknown> = {
  "quoteStyle": (v) => (v === "jp" ? "jp" : "zh"),
  "contextWindow": (v) => parseInt(v, 10) || 131072,
  "translation.concurrency": (v) => Math.min(8, Math.max(1, parseInt(v, 10) || 3)),
  "translation.batchChars": (v) => parseInt(v, 10) || 2000,
  "translation.guide": (v) => (v ? String(v) : undefined),
};

export interface Settings {
  quoteStyle: "zh" | "jp";
  contextWindow: number;
  translation: { concurrency: number; batchChars: number };
  [key: string]: unknown;
}

const CONFIG_PATH = (ws: Workspace) => join(ws.root, "config.json");

export const DEFAULT_SETTINGS: Settings = {
  quoteStyle: "zh",
  contextWindow: 131072,
  translation: { concurrency: 1, batchChars: 2000 },
};

/** 读设置（无文件 → 默认） */
export async function readSettings(ws: Workspace): Promise<Settings> {
  if (!existsSync(CONFIG_PATH(ws))) return { ...DEFAULT_SETTINGS };
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH(ws), "utf-8")) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      translation: { ...DEFAULT_SETTINGS.translation, ...(raw.translation ?? {}) },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** 写设置（白名单键；点路径支持嵌套） */
export async function writeSetting(ws: Workspace, key: string, value: string): Promise<boolean> {
  const parse = ALLOWED_KEYS[key];
  if (!parse) return false; // 未知键不写入（防错拼）
  const current = await readSettings(ws);
  const next = structuredClone(current) as Record<string, unknown>;
  const parts = key.split(".");
  let target = next;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    target[p] = target[p] ?? {};
    target = target[p] as Record<string, unknown>;
  }
  target[parts[parts.length - 1]!] = parse(value);
  await atomicWriteFile(CONFIG_PATH(ws), `${JSON.stringify(next, null, 2)}\n`);
  return true;
}
