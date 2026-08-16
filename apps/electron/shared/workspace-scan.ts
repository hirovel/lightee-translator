/**
 * 工作区磁盘布局的纯函数层（RH-11）。
 *
 * 只做「路径与文本 → 结构」的推导，不碰 IO 也不碰服务状态，因此可以被
 * workspace-service 与任何将来需要读同一布局的地方共用而不产生依赖环。
 */
import { createHash } from "node:crypto";

/** 工作区 id 由绝对路径哈希得到：同一目录无论打开多少次都是同一个 id */
export function workspaceIdFor(root: string): string {
  return `ws-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;
}

/** 从 book.yaml 文本里取一个顶层标量字段 */
export function bookField(book: string, key: string, fallback: string): string {
  return new RegExp(`^${key}:\\s*(.+)$`, "m").exec(book)?.[1]?.trim() || fallback;
}

/** book.yaml 的 volumes 段 → volumeId → 显示名。缺 label 时回落成 id 本身 */
export function parseVolumeLabels(book: string): Map<string, string> {
  const labels = new Map<string, string>();
  let current: string | null = null;
  for (const line of book.split(/\r?\n/)) {
    const id = /^\s*-\s*id:\s*(\S+)\s*$/.exec(line)?.[1];
    if (id) {
      current = id;
      labels.set(id, id);
      continue;
    }
    const label = /^\s*label:\s*(.+)$/.exec(line)?.[1];
    if (label && current) labels.set(current, label.trim());
  }
  return labels;
}
