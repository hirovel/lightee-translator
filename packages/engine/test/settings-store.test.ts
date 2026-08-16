/**
 * settings-store 测试：设置读写（workspace config.json）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { createWorkspace, type Workspace } from "../src/workspace.ts";
import { readSettings, writeSetting } from "../src/settings-store.ts";

let dir: string;
let ws: Workspace;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lightee-set-"));
  ws = await createWorkspace(dir, { name: "设置测试" });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("settings-store", () => {
  it("默认设置（无文件）", async () => {
    const s = await readSettings(ws);
    expect(s.quoteStyle).toBe("zh");
    expect(s.contextWindow).toBe(131072);
  });

  it("writeSetting 持久化（点路径）", async () => {
    await writeSetting(ws, "quoteStyle", "jp");
    const s = await readSettings(ws);
    expect(s.quoteStyle).toBe("jp");
    // 文件落盘
    const raw = JSON.parse(await readFile(join(dir, "config.json"), "utf-8"));
    expect(raw.quoteStyle).toBe("jp");
  });

  it("嵌套路径（translation.concurrency）", async () => {
    await writeSetting(ws, "translation.concurrency", "5");
    const s = await readSettings(ws);
    expect(s.translation.concurrency).toBe(5);
  });

  it("多值覆盖保留其他字段", async () => {
    await writeSetting(ws, "quoteStyle", "jp");
    await writeSetting(ws, "translation.concurrency", "2");
    const s = await readSettings(ws);
    expect(s.quoteStyle).toBe("jp");
    expect(s.translation.concurrency).toBe(2);
    expect(s.translation.batchChars).toBe(2000); // 未被覆盖
  });

  it("未知键 → 不写入（防错拼）", async () => {
    await writeSetting(ws, "nonexistent.key", "x");
    expect(existsSync(join(dir, "config.json"))).toBe(false);
  });
});
