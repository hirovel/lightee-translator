/**
 * KA-6 止血：模型登记的语气档案不再静默蒸发。
 *
 * 实测事故（2026-08-14 演示工作区）：register_terms 交付 2 份带原文引证的语气档案，
 * 过了补救层校验，然后全仓库没有任何消费者——voice.json 恒空、persona 注入恒空、
 * 零告警。ADR-0008 禁止 voices 自动入档，所以止血是「落待办 + 出声」，不是写档案。
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPendingVoices, recordPendingVoices } from "../src/pending-voices.ts";
import type { RegisteredVoice } from "../src/register-terms.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<{ root: string }> {
  const root = await mkdtemp(join(tmpdir(), "lightee-pending-voices-"));
  roots.push(root);
  await mkdir(join(root, "state"), { recursive: true });
  return { root };
}

const voice = (character: string, over: Partial<RegisteredVoice> = {}): RegisteredVoice => ({
  character,
  selfRef: "僕",
  register: "简体",
  gender: null,
  quirk: null,
  zhStrategy: "拘谨少年腔",
  evidence: "……",
  ...over,
});

describe("recordPendingVoices", () => {
  it("落盘并回读，条目带章节出处", async () => {
    const ws = await workspace();
    const added = await recordPendingVoices(ws, [voice("星野ひかり"), voice("月岡")], "ch001");
    expect(added.map((v) => v.character)).toEqual(["星野ひかり", "月岡"]);
    const read = await readPendingVoices(ws);
    expect(read).toHaveLength(2);
    expect(read[0]?.chapterId).toBe("ch001");
  });

  it("同一角色先到先得——后一章的再辨认不覆盖先例（与词档案同一取舍）", async () => {
    const ws = await workspace();
    await recordPendingVoices(ws, [voice("星野ひかり", { zhStrategy: "第一章的判断" })], "ch001");
    const second = await recordPendingVoices(ws, [voice("星野ひかり", { zhStrategy: "第二章的判断" })], "ch002");
    expect(second).toHaveLength(0);
    const read = await readPendingVoices(ws);
    expect(read).toHaveLength(1);
    expect(read[0]?.zhStrategy).toBe("第一章的判断");
    expect(read[0]?.chapterId).toBe("ch001");
  });

  it("零新增时不写盘也不出声（返回空 = 调用方不 warn）", async () => {
    const ws = await workspace();
    await recordPendingVoices(ws, [voice("星野ひかり")], "ch001");
    const again = await recordPendingVoices(ws, [voice("星野ひかり")], "ch002");
    expect(again).toEqual([]);
  });

  it("待办文件损坏时按空处理，不让一份坏文件炸掉整章翻译", async () => {
    const ws = await workspace();
    await writeFile(join(ws.root, "state", "pending-voices.json"), "{broken");
    expect(await readPendingVoices(ws)).toEqual([]);
    const added = await recordPendingVoices(ws, [voice("月岡")], "ch001");
    expect(added).toHaveLength(1);
    const raw = JSON.parse(await readFile(join(ws.root, "state", "pending-voices.json"), "utf-8")) as unknown[];
    expect(raw).toHaveLength(1);
  });
});
