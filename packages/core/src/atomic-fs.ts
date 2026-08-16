/**
 * 原子写入与文件操作 —— 参考 pi 的 write 工具实现（withFileMutationQueue + mkdir + abort 检查点），
 * 按 docs/lightee-wiki.md 原子写协议：写 tmp → fsync → rename 覆盖。
 *
 * 所有状态/术语/译文文件统一走这里，保证崩溃不产生半截文件。
 */

import { mkdir, rename, rm, open, readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/** 同文件操作队列：串行化对同一文件的并发操作（不同文件并行） */
const fileQueues = new Map<string, Promise<unknown>>();

export function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileQueues.get(filePath) ?? Promise.resolve();
  const next = prev.then(fn, fn); // 无论前一个成败，都继续执行本次
  // 吞掉错误避免链式污染（错误由调用方处理）
  fileQueues.set(
    filePath,
    next.catch(() => {})
  );
  return next;
}

const UNSUPPORTED_DIRECTORY_SYNC = new Set(["EINVAL", "ENOTSUP", "EBADF", "EISDIR", "EPERM", "EACCES"]);

async function syncDirectory(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !UNSUPPORTED_DIRECTORY_SYNC.has(code)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** 原子写：tmp 文件 → fsync → rename 覆盖 → 父目录 fsync。 */
export async function atomicWriteFile(filePath: string, content: string | Uint8Array): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    const fh = await open(tmpPath, "wx");
    try {
      await fh.writeFile(content, typeof content === "string" ? "utf-8" : undefined);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmpPath, filePath);
    await syncDirectory(dir);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 追加写（append-only 日志：events.jsonl / pending 队列），单次写不跨进程锁 */
export async function appendLine(filePath: string, line: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const fh = await open(filePath, "a");
  try {
    await fh.writeFile(line.endsWith("\n") ? line : line + "\n", "utf-8");
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** 读 JSON 文件（不存在返回 null，解析失败抛错） */
export async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** 原子写 JSON（带队列串行化，防并发交错） */
export function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  return withFileMutationQueue(filePath, () =>
    atomicWriteFile(filePath, JSON.stringify(data, null, 2) + "\n")
  );
}

/**
 * 工作区路径工具 —— 所有 Agent 文件操作限定在 workspace 根内（最小权限，官方 Wiki 安全设计）。
 */
export class WorkspacePaths {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** 把相对路径解析到工作区内；越界（..）抛错 */
  resolve(rel: string): string {
    const abs = resolve(this.root, rel);
    if (!abs.startsWith(this.root + sep) && abs !== this.root) {
      throw new Error(`路径越界: ${rel}（不允许访问工作区外）`);
    }
    return abs;
  }

  /** 章节原文 */
  sourceChapter(chapterId: string): string {
    return this.resolve(join("source", `${chapterId}.md`));
  }
  /** 章节译文 */
  translation(chapterId: string): string {
    return this.resolve(join("translations", `${chapterId}_zh.md`));
  }
  /** 术语表文件 */
  terminology(file: string): string {
    return this.resolve(join("terminology", file));
  }
  /** 状态快照 */
  chapterState(): string {
    return this.resolve(join("state", "chapter_state.json"));
  }
  /** 事件日志（append-only） */
  eventsLog(): string {
    return this.resolve(join("state", "events.jsonl"));
  }
  /** Agent 实例 Scratchpad（私有目录） */
  scratchpad(agentId: string): string {
    return this.resolve(join(".agents", agentId));
  }
  /** 会话日志 */
  session(agentId: string): string {
    return this.resolve(join("sessions", `${agentId}.jsonl`));
  }
  /** 审校报告 */
  review(): string {
    return this.resolve(join("reviews", "consistency.json"));
  }
}
