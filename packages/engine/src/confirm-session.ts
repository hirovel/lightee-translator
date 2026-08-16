/**
 * confirm-session —— 术语裁决会话（无 UI 依赖）。
 *
 * 设计（2026-07-31 确认）:
 *   CLI/TUI/Electron 三端口共享同一 session API（引擎无 UI，UI 只是端口）
 *   进度存 state/confirm-session.json（切端不丢：CLI 确认一半 → TUI 继续）
 *   裁决 → finishSession 应用 → 写 terminology/*.json（冻结）
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Workspace } from "./workspace.ts";
import {
  buildCard,
  filterByVerdict,
  type AppliedEntry,
  type DecisionCard,
  type Verdict,
} from "@lightee/core/evidence-card";
import { atomicWriteJson } from "@lightee/core/atomic-fs";
import { TerminologyRepository, type TerminologyArchive } from "@lightee/core/terminology-repository";

// ===== 会话 =====
export interface ConfirmSession {
  cards: DecisionCard[];
  /** 当前卡位置 */
  index: number;
  /** 已裁决（按卡顺序） */
  verdicts: Verdict[];
  /** 会话状态标记（finish 后清理） */
  done: boolean;
  /** Monotonic session revision for cross-process stale-write detection. */
  revision?: number;
  /** Generation identity prevents stale objects from writing a replaced session. */
  sessionId?: string;
}

export type SessionAction =
  | { action: "accept"; chosenZh?: string; chosenCharacter?: string }
  | { action: "modify"; chosenZh: string; chosenCharacter?: string }
  | { action: "skip" }
  | { action: "back" }
  | { action: "quit" };

const CARDS_PATH = (ws: Workspace) => join(ws.root, "state", "cards.json");
const SESSION_PATH = (ws: Workspace) => join(ws.root, "state", "confirm-session.json");
const STATUS_PATH = (ws: Workspace) => join(ws.root, "state", "terminology-status.json");

export class ConfirmSessionConflictError extends Error {
  readonly code = "conflict" as const;

  constructor(message = "Confirmation session changed in another process") {
    super(message);
    this.name = "ConfirmSessionConflictError";
  }
}

async function readStatusUnlocked(ws: Workspace): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(STATUS_PATH(ws), "utf-8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function writePendingStatusUnlocked(ws: Workspace, session: ConfirmSession): Promise<void> {
  const existing = await readStatusUnlocked(ws);
  await atomicWriteJson(STATUS_PATH(ws), {
    ...existing,
    status: "pending",
    cardCount: session.cards.length,
    pendingCount: Math.max(0, session.cards.length - session.index),
    confirmedCount: session.index,
    updatedAt: Date.now(),
  });
}

async function writeConfirmedStatusUnlocked(ws: Workspace, session: ConfirmSession): Promise<void> {
  const existing = await readStatusUnlocked(ws);
  await atomicWriteJson(STATUS_PATH(ws), {
    ...existing,
    status: "confirmed",
    cardCount: session.cards.length,
    pendingCount: 0,
    confirmedCount: session.cards.length,
    updatedAt: Date.now(),
  });
}

// ===== 会话生命周期 =====
export async function createSession(ws: Workspace, cards: DecisionCard[]): Promise<ConfirmSession> {
  const session: ConfirmSession = { cards, index: 0, verdicts: [], done: false, revision: 0, sessionId: randomUUID() };
  const repository = new TerminologyRepository(ws.root);
  await repository.withTransaction(async () => {
    await atomicWriteJson(CARDS_PATH(ws), cards);
    await atomicWriteJson(SESSION_PATH(ws), session);
    await writePendingStatusUnlocked(ws, session);
    await repository.recordStatusInTransaction(`confirm-session:${session.sessionId}:created`);
  });
  return session;
}

/**
 * 向确认队列追加卡片。
 *
 * 只能追加在**末尾**：`index` 是进度指针、`verdicts` 按卡顺序对齐，从中间插入会让二者同时错位。
 * 无活动会话（或上一轮已完成）时新建一轮。
 *
 * 用于翻译途中发现的新术语——它们产生在 prepareTerminology 之后，赶不上那一轮的队列。
 */
export async function appendCards(ws: Workspace, cards: DecisionCard[]): Promise<ConfirmSession | null> {
  if (cards.length === 0) return loadSession(ws);
  const existing = await loadSession(ws);
  if (!existing) return createSession(ws, cards);

  const repository = new TerminologyRepository(ws.root);
  let merged: ConfirmSession | null = null;
  await repository.withTransaction(async () => {
    // 事务内重新载入：并发的裁决可能已经推进了进度，用外面那份会把它写回去
    const current = await loadSession(ws);
    if (!current) {
      merged = null;
      return;
    }
    const known = new Set(current.cards.map((card) => card.ja));
    const fresh = cards.filter((card) => !known.has(card.ja));
    if (fresh.length === 0) {
      merged = current;
      return;
    }
    current.cards = [...current.cards, ...fresh];
    current.revision = (current.revision ?? 0) + 1;
    await atomicWriteJson(CARDS_PATH(ws), current.cards);
    await atomicWriteJson(SESSION_PATH(ws), current);
    await writePendingStatusUnlocked(ws, current);
    await repository.recordStatusInTransaction(`confirm-append:${current.sessionId}:${current.revision}`);
    merged = current;
  });
  return merged ?? createSession(ws, cards);
}

/** 恢复进度（无 session 文件 → null） */
export async function loadSession(ws: Workspace): Promise<ConfirmSession | null> {
  if (!existsSync(SESSION_PATH(ws))) return null;
  try {
    const raw = await readFile(SESSION_PATH(ws), "utf-8");
    const s = JSON.parse(raw) as ConfirmSession;
    if (!Array.isArray(s.cards) || s.done) return null;
    s.revision = typeof s.revision === "number" && Number.isSafeInteger(s.revision) && s.revision >= 0 ? s.revision : 0;
    if (typeof s.sessionId !== "string" || s.sessionId.length === 0) {
      const modifiedAt = await stat(SESSION_PATH(ws)).then((value) => value.mtimeMs).catch(() => 0);
      s.sessionId = `legacy:${createHash("sha256").update(`${raw}\u0000${modifiedAt}`).digest("hex")}`;
    }
    // cards 与 session 分离存储时，session 里可能只有引用 → 从 cards.json 读
    if (s.cards.length === 0 && existsSync(CARDS_PATH(ws))) {
      s.cards = JSON.parse(await readFile(CARDS_PATH(ws), "utf-8")) as DecisionCard[];
    }
    return s;
  } catch {
    return null;
  }
}

export function currentCard(session: ConfirmSession): DecisionCard | null {
  return session.cards[session.index] ?? null;
}

/** 持久化会话进度（b 后退/手动保存用） */
export async function saveSession(ws: Workspace, session: ConfirmSession): Promise<void> {
  const repository = new TerminologyRepository(ws.root);
  await repository.withTransaction(async () => {
    const current = await loadSession(ws);
    const expectedRevision = session.revision ?? 0;
    if (!current || current.sessionId !== session.sessionId || (current.revision ?? 0) !== expectedRevision) throw new ConfirmSessionConflictError();
    session.revision = expectedRevision + 1;
    await atomicWriteJson(SESSION_PATH(ws), session);
    await writePendingStatusUnlocked(ws, session);
    await repository.recordStatusInTransaction(`confirm-progress:${session.sessionId}:${session.revision}`);
  });
}

// ===== 裁决 =====
export async function verdict(
  ws: Workspace,
  session: ConfirmSession,
  v: Omit<Verdict, "ja">
): Promise<void> {
  const card = session.cards[session.index];
  if (!card) return;
  session.verdicts.push({ ...v, ja: card.ja });
  session.index += 1;
  await saveSession(ws, session);
}

/** 应用全部裁决 → 通过共享术语仓库写入（冻结）→ 清理 session */
export async function finishSession(
  ws: Workspace,
  session: ConfirmSession,
  options: { afterCommit?: (applied: AppliedEntry[]) => Promise<void> } = {},
): Promise<AppliedEntry[]> {
  const applied = filterByVerdict(session.cards, session.verdicts);
  const entries = applied.map((entry) => {
    const archive = entry.type === "name"
      ? "names"
      : entry.type === "term"
        ? "terms"
        : entry.type === "pun"
          ? "puns"
            : entry.type === "voice"
              ? "voice"
              : entry.type === "onomatopoeia"
                ? "onomatopoeia"
                : "terms";
    const selfRefJa = (entry as AppliedEntry & { selfRefJa?: unknown }).selfRefJa;
    const value = entry.type === "voice"
      ? { ...entry, selfRefZh: typeof selfRefJa === "string" && selfRefJa ? entry.zh : "", status: "confirmed" }
      : { ...entry };
    return { archive: archive as TerminologyArchive, entry: value as Record<string, unknown> };
  });
  const operationId = createHash("sha256")
    .update(JSON.stringify({ cards: session.cards, verdicts: session.verdicts }))
    .digest("hex");
  const repository = new TerminologyRepository(ws.root);
  await repository.withTransaction(async () => {
    const current = await loadSession(ws);
    const expectedRevision = session.revision ?? 0;
    if (!current || current.sessionId !== session.sessionId || (current.revision ?? 0) !== expectedRevision) throw new ConfirmSessionConflictError();
    await repository.mergeEntriesInTransaction({ operationId: `confirm:${operationId}`, action: "confirmed", entries });
    await writeConfirmedStatusUnlocked(ws, session);
    await repository.recordStatusInTransaction(`confirm-session:${session.sessionId}:completed:${expectedRevision}`);
    if (options.afterCommit) await options.afterCommit(applied);
    const latest = await loadSession(ws);
    if (!latest || latest.sessionId !== session.sessionId || (latest.revision ?? 0) !== expectedRevision) throw new ConfirmSessionConflictError();
    if (existsSync(SESSION_PATH(ws))) await rm(SESSION_PATH(ws), { force: true });
  });
  return applied;
}

// ===== 输入解析（CLI/TUI 统一）=====
export function parseAction(input: string, card: DecisionCard): SessionAction | null {
  const v = input.trim();
  const numM = /^(\d+)$/.exec(v);
  if (numM) {
    const idx = parseInt(numM[1]!, 10) - 1;
    const c = card.candidates[idx];
    if (c) return { action: "accept", chosenZh: c.zh };
    return null;
  }
  const modM = /^m\s+(.+)$/.exec(v);
  if (modM) return { action: "modify", chosenZh: modM[1]!.trim() };
  if (v === "s") return { action: "skip" };
  if (v === "b") return { action: "back" };
  if (v === "q") return { action: "quit" };
  return null;
}

/** 渲染决策卡文本（CLI/TUI 共用展示） */
export function renderCard(card: DecisionCard, index: number, total: number): string {
  const lines: string[] = [];
  lines.push(`── 术语确认 ${index + 1}/${total} ──`);
  lines.push(`${card.ja}${card.reading ? ` (${card.reading})` : ""} · ${card.type}`);
  if (card.context) lines.push(`  示例: ${card.context.slice(0, 60)}`);
  card.candidates.forEach((c, i) => {
    const ev = c.evidence.length > 0 ? ` [证据: ${c.evidence[0]!.snippet.slice(0, 40)}…]` : "";
    lines.push(`  [${i + 1}] ${c.zh} (${(c.confidence * 100).toFixed(0)}%)${ev}`);
  });
  lines.push(`  输入: 数字选候选 · m 译名 自定义 · s 跳过 · b 后退 · q 退出保存进度`);
  return lines.join("\n");
}
