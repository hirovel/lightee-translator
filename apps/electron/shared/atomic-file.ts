import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const queues = new Map<string, Promise<unknown>>();
/** 当前异步上下文已持有的文件临界区（可重入判定用） */
const heldFiles = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * 文件级写队列（ADR-0005：每个文件身份一把写权威）。
 *
 * - key 以 `resolve()` 归一：同一文件不会因路径写法不同分裂成两把锁。
 * - **可重入**：临界区内再次对同一文件调用（典型场景是 read-modify-write 的回调里调用
 *   `atomicWriteJson`）直接执行，不再入队——否则自锁死等。
 */
export function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(filePath);
  const current = heldFiles.getStore();
  if (current?.has(key)) return fn();
  const owned = new Set(current ?? []);
  owned.add(key);
  const run = () => heldFiles.run(owned, fn);
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  const tail = next.then(() => undefined, () => undefined);
  queues.set(key, tail);
  // 尾清理（M-6）：本条是队尾时把 key 移除，否则 Map 会随访问过的文件数单调增长。
  // 只在「仍是自己」时删，避免删掉后来者的队尾。
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return next;
}

/** 仅测试用：当前仍在排队的文件数（M-6 尾清理的可观测点） */
export function pendingFileMutationQueues(): number {
  return queues.size;
}

const UNSUPPORTED_DIRECTORY_SYNC = new Set(["EINVAL", "ENOTSUP", "EBADF", "EISDIR", "EPERM", "EACCES"]);

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !UNSUPPORTED_DIRECTORY_SYNC.has(code)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = join(directory, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    const handle = await open(tempPath, "wx");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, filePath);
    await syncDirectory(directory);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  return withFileMutationQueue(filePath, () => atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`));
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

/** 文件是否存在。缺失以外的错误（权限等）一律当作「不存在」向上游让路——调用方只关心可读性。 */
export async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读文本；文件不存在时返回 `fallback`。
 * 只吞 ENOENT——权限/IO 错误必须抛出，否则「读到空串」会被误当成「内容为空」。
 */
export async function readText(filePath: string, fallback = ""): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return fallback;
    throw error;
  }
}
