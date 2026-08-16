/**
 * IV-02 —— 工作区创建的两条路径必须产出同一个工作区。
 *
 * 为什么这条测试比「函数只准有一份」更本质：Q 批那次事故里，两个入口的**形状**从来
 * 就不一样（一个是 engine 的导出函数、一个是 Electron 服务的方法），任何基于名字的
 * 文本断言都拦不住。真正出问题的是**行为**——engine 一侧播了译后规则，Electron 一侧
 * 没播，而真实用户走的正是后者。所以这里断言的是结果：两条路径落在磁盘上的东西逐项相同。
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspace } from "@lightee/engine";
import { createIpcService } from "./ipc-service.js";

/** 工作区内的全部目录（相对路径，POSIX 分隔符，排序） */
async function directoryTree(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      found.push(relative(root, full).split("\\").join("/"));
      await walk(full);
    }
  };
  await walk(root);
  return found.sort();
}

/** 工作区内的全部文件（相对路径，POSIX 分隔符，排序） */
async function fileTree(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(relative(root, full).split("\\").join("/"));
    }
  };
  await walk(root);
  return found.sort();
}

function bookFields(book: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of book.split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9_]*):\s*(.+)$/.exec(line);
    if (match) fields[match[1]!] = match[2]!.trim();
  }
  return fields;
}

describe("IV-02 工作区创建双路径", () => {
  it("engine 与 Electron 两条创建路径产出相同的目录、文件与 book.yaml 字段", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "lightee-iv02-"));
    try {
      const viaEngine = join(sandbox, "engine-path");
      const viaElectron = join(sandbox, "electron-path");

      await createWorkspace(viaEngine, { name: "双路径测试", srcLang: "ja", tgtLang: "zh" });

      const service = createIpcService({ registryPath: join(sandbox, "user", "workspaces.json") });
      const created = await service.invoke({
        version: 1,
        requestId: "iv02-create",
        command: "workspace.create",
        payload: { path: viaElectron, name: "双路径测试", srcLang: "ja", tgtLang: "zh" },
      });
      expect(created.ok).toBe(true);

      expect(await directoryTree(viaElectron)).toEqual(await directoryTree(viaEngine));
      expect(await fileTree(viaElectron)).toEqual(await fileTree(viaEngine));

      const engineBook = bookFields(await readFile(join(viaEngine, "book.yaml"), "utf8"));
      const electronBook = bookFields(await readFile(join(viaElectron, "book.yaml"), "utf8"));
      expect(electronBook).toEqual(engineBook);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
