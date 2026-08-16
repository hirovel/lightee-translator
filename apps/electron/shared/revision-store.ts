/**
 * 乐观并发用的 revision 计数（RH-11）。
 *
 * `state/ipc-revisions.json` 一个文件承载全部 key（`settings` / `reviewRules` /
 * `chapter:<id>`）。settings、章节草稿、审校规则三条写路径都要读写它，因此它既不属于
 * 某一个服务，也不属于进程编排——单独成模，由 `withFileMutationQueue` 保证写权威唯一。
 */
import { join } from "node:path";
import { atomicWriteFile, readJson, withFileMutationQueue } from "./atomic-file.js";

function revisionsPath(root: string): string {
  return join(root, "state", "ipc-revisions.json");
}

/** 读取某个 key 的当前 revision；文件缺失、值非法或为负一律视作 0（首次写入的基线） */
export async function readRevision(root: string, key: string): Promise<number> {
  const revisions = await readJson<Record<string, number>>(revisionsPath(root), {});
  const value = revisions[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** 写入某个 key 的 revision。整段 read-modify-write 在文件队列内完成，避免并发互相覆盖 */
export async function writeRevision(root: string, key: string, revision: number): Promise<void> {
  const path = revisionsPath(root);
  await withFileMutationQueue(path, async () => {
    const revisions = await readJson<Record<string, number>>(path, {});
    revisions[key] = revision;
    await atomicWriteFile(path, `${JSON.stringify(revisions, null, 2)}\n`);
  });
}
