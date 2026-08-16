import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendLineWithRotation } from "./rotating-jsonl.js";

/**
 * 这一组守的是「~/.lightee/llm-history.jsonl 只增不减」这个后果：
 * 它存的是原文与译文全文，一本 300 章的书约 37MB，而译者会一本接一本地译。
 */
describe("appendLineWithRotation", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lightee-rot-"));
    file = join(dir, "llm-history.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const line = (n: number) => `${JSON.stringify({ n, pad: "x".repeat(200) })}\n`;

  it("未超限时就是普通追加，不产生任何归档", () => {
    appendLineWithRotation(file, line(1), { maxBytes: 10_000 });
    appendLineWithRotation(file, line(2), { maxBytes: 10_000 });
    expect(readFileSync(file, "utf-8").split("\n").filter(Boolean)).toHaveLength(2);
    expect(readdirSync(dir)).toEqual(["llm-history.jsonl"]);
  });

  it("超限时轮转：规范路径重新开始，旧内容进归档", () => {
    for (let i = 0; i < 6; i += 1) appendLineWithRotation(file, line(i), { maxBytes: 600, maxFiles: 5 });
    const names = readdirSync(dir).sort();
    expect(names).toContain("llm-history.jsonl");
    expect(names).toContain("llm-history.1.jsonl");
    // 规范路径永远是最新的那份：最后写进去的那行必须在它里面
    expect(readFileSync(file, "utf-8")).toContain('"n":5');
  });

  it("保留份数封顶——这正是「只增不减」要治的病", () => {
    for (let i = 0; i < 40; i += 1) appendLineWithRotation(file, line(i), { maxBytes: 400, maxFiles: 3 });
    const names = readdirSync(dir).filter((n) => n.startsWith("llm-history"));
    expect(names.length).toBeLessThanOrEqual(3);
  });

  it("清理按 mtime 而不是文件名——字典序会把最老的一份排在后面而永远删不掉", () => {
    // 摆一个「文件名序与时间序相反」的现场：字典序是 .1 < .10，时间序却是 .10 更老。
    // 只触发**一次**轮转、只淘汰**一份**，两种排序才会给出不同的存活者：
    //   按 mtime → 淘汰 .10（正确）；按文件名 → 淘汰 .1（错误，最老的反而留下）
    writeFileSync(file, "x".repeat(250) + "\n");
    const older = join(dir, "llm-history.10.jsonl");
    const newer = join(dir, "llm-history.1.jsonl");
    writeFileSync(older, line(1));
    writeFileSync(newer, line(2));
    const t = statSync(file).mtimeMs / 1000;
    utimesSync(older, t - 9000, t - 9000);
    utimesSync(newer, t - 10, t - 10);

    // 250 + 这一行 > 300 → 轮转一次（当前文件改名为最小空闲序号 .2），随后清理
    appendLineWithRotation(file, "y".repeat(100) + "\n", { maxBytes: 300, maxFiles: 3 });

    const names = readdirSync(dir);
    expect(names).not.toContain("llm-history.10.jsonl"); // 最老的必须被淘汰
    expect(names).toContain("llm-history.1.jsonl"); // 较新的必须留下
  });

  it("单行本身就超限时不能每行切一个文件", () => {
    const huge = `${"y".repeat(5000)}\n`;
    appendLineWithRotation(file, huge, { maxBytes: 1000, maxFiles: 5 });
    appendLineWithRotation(file, huge, { maxBytes: 1000, maxFiles: 5 });
    appendLineWithRotation(file, huge, { maxBytes: 1000, maxFiles: 5 });
    const names = readdirSync(dir).filter((n) => n.startsWith("llm-history"));
    // 三行三个文件是可接受的下限；但绝不能因为「空文件也判超限」而无限切分
    expect(names.length).toBeLessThanOrEqual(3);
    expect(readFileSync(file, "utf-8").length).toBeGreaterThan(0);
  });

  it("写入失败不抛出——历史写盘拖垮 LLM 调用是本末倒置", () => {
    const nested = join(dir, "no-such", "deep");
    mkdirSync(nested, { recursive: true });
    // 传一个目录当文件路径：append 必然失败，但不允许抛
    expect(() => appendLineWithRotation(nested, line(1), { maxBytes: 100 })).not.toThrow();
  });
});
