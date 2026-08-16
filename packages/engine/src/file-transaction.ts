import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteFile, atomicWriteJson } from "@lightee/core/atomic-fs";

interface SnapshotEntry {
  path: string;
  kind: "absent" | "file" | "directory";
  data?: string;
}

interface TransactionJournal {
  version: 1;
  id: string;
  phase: "prepared" | "committed";
  entries: SnapshotEntry[];
}

function inside(root: string, path: string): string {
  const absolute = resolve(path);
  const base = resolve(root);
  if (absolute !== base && !absolute.startsWith(`${base}${sep}`)) throw new Error(`事务路径越界: ${path}`);
  return relative(base, absolute);
}

async function snapshotPath(root: string, absolute: string, txDir: string, entries: SnapshotEntry[]): Promise<void> {
  const rel = inside(root, absolute);
  let stat;
  try { stat = await lstat(absolute); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") { entries.push({ path: rel, kind: "absent" }); return; }
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`事务路径不允许符号链接: ${rel}`);
  if (stat.isDirectory()) {
    entries.push({ path: rel, kind: "directory" });
    for (const child of await readdir(absolute)) await snapshotPath(root, join(absolute, child), txDir, entries);
    return;
  }
  if (!stat.isFile()) throw new Error(`事务路径不是普通文件: ${rel}`);
  const data = `${entries.length}.bin`;
  await atomicWriteFile(join(txDir, data), await readFile(absolute));
  entries.push({ path: rel, kind: "file", data });
}

async function rollback(root: string, txDir: string, entries: SnapshotEntry[]): Promise<void> {
  const roots = entries.filter((entry) => !entries.some((other) => other.path !== entry.path && entry.path.startsWith(`${other.path}${sep}`)));
  for (const entry of roots) await rm(join(root, entry.path), { recursive: true, force: true });
  for (const entry of entries.filter((item) => item.kind === "directory").sort((a, b) => a.path.length - b.path.length)) {
    await mkdir(join(root, entry.path), { recursive: true });
  }
  for (const entry of entries.filter((item) => item.kind === "file")) {
    const target = join(root, entry.path);
    await mkdir(dirname(target), { recursive: true });
    await atomicWriteFile(target, await readFile(join(txDir, entry.data!)));
  }
}

export async function withWorkspaceFileTransaction<T>(root: string, paths: string[], fn: () => Promise<T>): Promise<T> {
  const id = `fstx-${randomUUID()}`;
  const txDir = join(root, "state", "fs-transactions", id);
  await mkdir(txDir, { recursive: true });
  const entries: SnapshotEntry[] = [];
  const unique = [...new Set(paths.map((path) => resolve(path)))];
  for (const path of unique) await snapshotPath(root, path, txDir, entries);
  const journalPath = join(txDir, "journal.json");
  await atomicWriteJson(journalPath, { version: 1, id, phase: "prepared", entries } satisfies TransactionJournal);
  try {
    const result = await fn();
    await atomicWriteJson(journalPath, { version: 1, id, phase: "committed", entries } satisfies TransactionJournal);
    await rm(txDir, { recursive: true, force: true });
    return result;
  } catch (error) {
    await rollback(root, txDir, entries);
    await rm(txDir, { recursive: true, force: true });
    throw error;
  }
}

export async function recoverWorkspaceFileTransactions(root: string): Promise<number> {
  const parent = join(root, "state", "fs-transactions");
  let dirs: string[];
  try { dirs = await readdir(parent); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let recovered = 0;
  for (const name of dirs) {
    const txDir = join(parent, name);
    const journalPath = join(txDir, "journal.json");
    let journal: TransactionJournal;
    try { journal = JSON.parse(await readFile(journalPath, "utf8")) as TransactionJournal; }
    catch { throw new Error(`文件事务 journal 损坏: ${relative(root, journalPath)}`); }
    if (journal.version !== 1 || !Array.isArray(journal.entries)) throw new Error(`文件事务 journal schema 无效: ${name}`);
    for (const entry of journal.entries) inside(root, join(root, entry.path));
    if (journal.phase === "prepared") { await rollback(root, txDir, journal.entries); recovered += 1; }
    else if (journal.phase !== "committed") throw new Error(`文件事务 phase 无效: ${name}`);
    await rm(txDir, { recursive: true, force: true });
  }
  return recovered;
}
