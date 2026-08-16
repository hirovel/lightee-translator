/**
 * 测试临时目录清扫（vitest globalSetup）。
 *
 * 32 个测试文件用 `mkdtemp(join(tmpdir(), "lightee-…"))` 建临时工作区，其中不少在
 * 断言失败或提前 return 时不会走到清理。实测积压到 **2030 个残留目录**，而且这不只是
 * 占磁盘——它会真的把测试跑挂：`rm(root, { recursive: true })` 撞上仍在被后台写入的
 * 目录会抛 `ENOTEMPTY`，表现为随机的、换个文件单独跑就好了的「flaky」。
 *
 * 因此清扫放在 globalSetup 的 teardown：**只删本次运行期间创建的**（按 mtime 与启动
 * 时间比较），不碰别的进程或别的会话留下的目录——并行跑两个测试会话时互相删对方的
 * 工作目录，会造出比残留更难查的问题。
 *
 * 这是兜底，不是许可：新测试仍应自己 `afterEach` 清理。
 */
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = "lightee-";

/**
 * 白名单：同样以 `lightee-` 开头、但**不是**测试临时目录的东西。
 * 规模压测 fixture 建一次要几十秒（5000 术语 / 20000 事件 / 10 本书），
 * 被顺手删掉只会让人以为压测脚本坏了。
 */
const KEEP = new Set(["lightee-scale-fixture"]);

export async function setup(): Promise<() => Promise<void>> {
  const startedAt = Date.now();
  return async () => {
    const root = tmpdir();
    const names = await readdir(root).catch(() => [] as string[]);
    let removed = 0;
    for (const name of names) {
      if (!name.startsWith(PREFIX) || KEEP.has(name)) continue;
      const path = join(root, name);
      // 只清本次运行创建的：比启动时间早的一律不碰
      const created = await stat(path).then((s) => Math.max(s.birthtimeMs, s.mtimeMs)).catch(() => 0);
      if (created < startedAt) continue;
      // maxRetries 是 Node 专门为 Windows 留的口子：目录里还有被杀软扫描或索引服务
      // 占着的句柄时，rm 会抛 ENOTEMPTY/EBUSY/EPERM，而这类占用通常只持续几百毫秒。
      // 不重试的话，清扫会在最需要它的那一次（跑批刚结束、写入余波未平）恰好失败。
      const ok = await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        .then(() => true, () => false);
      if (ok) removed += 1;
    }
    if (removed > 0) console.log(`[vitest] 清理了 ${removed} 个本次运行残留的临时目录`);
  };
}
