import { describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  appendLine,
  atomicWriteFile,
  atomicWriteJson,
  readJson,
  withFileMutationQueue,
  WorkspacePaths,
} from "../src/atomic-fs.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "lightee-test-"));
}

describe("原子写", () => {
  it("写入后可读，内容完整", async () => {
    const dir = tempDir();
    const f = join(dir, "test.txt");
    await atomicWriteFile(f, "hello 世界");
    expect(readFileSync(f, "utf-8")).toBe("hello 世界");
  });

  it("自动创建父目录", async () => {
    const dir = tempDir();
    const f = join(dir, "a", "b", "c.txt");
    await atomicWriteFile(f, "deep");
    expect(readFileSync(f, "utf-8")).toBe("deep");
  });

  it("覆盖写入不产生 tmp 残留", async () => {
    const dir = tempDir();
    const f = join(dir, "x.txt");
    await atomicWriteFile(f, "v1");
    await atomicWriteFile(f, "v2");
    expect(readFileSync(f, "utf-8")).toBe("v2");
    const leftovers = readdirSync(dir).filter((n) => n.startsWith(".tmp-"));
    expect(leftovers).toHaveLength(0);
  });

  it("atomicWriteJson + readJson 往返", async () => {
    const dir = tempDir();
    const f = join(dir, "state.json");
    await atomicWriteJson(f, { state: "ready", n: 42 });
    const data = await readJson<{ state: string; n: number }>(f);
    expect(data?.state).toBe("ready");
    expect(data?.n).toBe(42);
  });

  it("readJson 不存在返回 null", async () => {
    const dir = tempDir();
    expect(await readJson(join(dir, "nope.json"))).toBeNull();
  });

  it("appendLine 追加且换行正确", async () => {
    const dir = tempDir();
    const f = join(dir, "events.jsonl");
    await appendLine(f, JSON.stringify({ a: 1 }));
    await appendLine(f, JSON.stringify({ b: 2 }));
    const lines = readFileSync(f, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ a: 1 });
    expect(JSON.parse(lines[1]!)).toEqual({ b: 2 });
  });
});

describe("文件队列串行化", () => {
  it("同文件并发写串行执行（不同文件并行）", async () => {
    const dir = tempDir();
    const f = join(dir, "q.txt");
    // 并发 5 个追加（通过队列内 read-modify-write 模拟）
    const tasks = Array.from({ length: 5 }, (_, i) =>
      withFileMutationQueue(f, async () => {
        const prev = existsSync(f) ? readFileSync(f, "utf-8") : "";
        await atomicWriteFile(f, prev + i);
      })
    );
    await Promise.all(tasks);
    // 串行化保证顺序: 01234
    expect(readFileSync(f, "utf-8")).toBe("01234");
  });
});

describe("工作区路径", () => {
  it("解析到工作区内", () => {
    const w = new WorkspacePaths("/ws");
    const src = w.sourceChapter("ch001");
    expect(src.endsWith(join("source", "ch001.md"))).toBe(true);
    expect(src.includes("ws" + sep)).toBe(true);
    expect(w.translation("ch001").endsWith(join("translations", "ch001_zh.md"))).toBe(true);
    expect(w.terminology("names.json").endsWith(join("terminology", "names.json"))).toBe(true);
    expect(w.scratchpad("tr-ch001").endsWith(join(".agents", "tr-ch001"))).toBe(true);
  });

  it("越界路径被拒绝", () => {
    const w = new WorkspacePaths("/ws");
    expect(() => w.resolve("../evil.txt")).toThrow(/路径越界/);
    expect(() => w.resolve("../../etc/passwd")).toThrow(/路径越界/);
  });

  it("Windows 风格路径越界检测", () => {
    const w = new WorkspacePaths("C:\\ws");
    expect(() => w.resolve("..\\..\\windows\\system32")).toThrow(/路径越界/);
  });
});
