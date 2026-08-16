import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { createWorkspace, type Workspace } from "../src/workspace.ts";
import { extractPendingTerms, promotePendingTerms, readPendingTerms, recordPendingTerms } from "../src/pending-terms.ts";
import { createSession, loadSession } from "../src/confirm-session.ts";
import { buildCard } from "@lightee/core/evidence-card";

async function workspace(): Promise<{ ws: Workspace; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "promote-pending-"));
  const ws = await createWorkspace(dir, { name: "t" });
  mkdirSync(join(dir, "state"), { recursive: true });
  return { ws, dir };
}

describe("译法不从上下文里切", () => {
  /**
   * 译法紧邻标记之前，但中文没有词边界：贪婪取字会得到「他打开了道具箱」而不是「道具箱」。
   * 切错边界的预填候选会被用户顺手接受，比留空更糟，因此整句给用户、由人自己认。
   */
  it("上下文保留整句，卡片候选不猜译法", () => {
    const [term] = extractPendingTerms("他打开了道具箱【待审:アイテムボックス】。");
    expect(term!.context).toContain("他打开了道具箱");
    expect(term).not.toHaveProperty("zh");
  });
});

describe("新术语进入确认队列", () => {
  it("无活动会话 → 新建会话，候选可被确认", async () => {
    const { ws, dir } = await workspace();
    await recordPendingTerms(ws, extractPendingTerms("道具箱【待审:アイテムボックス】", "ch001"), new Set());

    const result = await promotePendingTerms(ws);
    expect(result.added).toBe(1);

    const session = await loadSession(ws);
    expect(session!.cards.map((c) => c.ja)).toEqual(["アイテムボックス"]);
    // 卡片带上下文，用户据此认出译者的译法
    expect(session!.cards[0]!.context).toContain("道具箱");
    // 已入队的候选从待办文件里移除，不会重复入队
    expect(await readPendingTerms(ws)).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it("有活动会话 → 追加在末尾，不打乱已裁决进度", async () => {
    const { ws, dir } = await workspace();
    const existing = await createSession(ws, [
      buildCard({ ja: "アリス", type: "name", candidates: [{ zh: "爱丽丝", confidence: 0.9 }] }),
      buildCard({ ja: "ボブ", type: "name", candidates: [{ zh: "鲍勃", confidence: 0.9 }] }),
    ]);
    existing.index = 1;
    existing.verdicts = [{ ja: "アリス", action: "accept", chosenZh: "爱丽丝" }];
    const { saveSession } = await import("../src/confirm-session.ts");
    await saveSession(ws, existing);

    await recordPendingTerms(ws, extractPendingTerms("道具箱【待审:アイテムボックス】", "ch001"), new Set());
    await promotePendingTerms(ws);

    const session = await loadSession(ws);
    expect(session!.cards.map((c) => c.ja)).toEqual(["アリス", "ボブ", "アイテムボックス"]);
    // 进度指针与已裁决记录必须原样保留
    expect(session!.index).toBe(1);
    expect(session!.verdicts).toHaveLength(1);
    await rm(dir, { recursive: true, force: true });
  });

  it("已在术语档案里的词不入队", async () => {
    const { ws, dir } = await workspace();
    writeFileSync(join(dir, "terminology", "names.json"), JSON.stringify([{ ja: "アリス", zh: "爱丽丝", type: "name" }]));
    // 绕过 record 的过滤，直接写入待办，验证 promote 自己也会再查一次档案
    await recordPendingTerms(ws, extractPendingTerms("爱丽丝【待审:アリス】", "ch001"), new Set());

    const result = await promotePendingTerms(ws);
    expect(result.added).toBe(0);
    expect(await loadSession(ws)).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it("会话里已有同一词 → 不重复入队", async () => {
    const { ws, dir } = await workspace();
    await createSession(ws, [buildCard({ ja: "アイテムボックス", type: "term", candidates: [{ zh: "道具箱", confidence: 0.7 }] })]);
    await recordPendingTerms(ws, extractPendingTerms("道具箱【待审:アイテムボックス】", "ch001"), new Set());

    expect((await promotePendingTerms(ws)).added).toBe(0);
    expect((await loadSession(ws))!.cards).toHaveLength(1);
    await rm(dir, { recursive: true, force: true });
  });

  it("无待办 → 不建会话、不改状态", async () => {
    const { ws, dir } = await workspace();
    expect((await promotePendingTerms(ws)).added).toBe(0);
    expect(await loadSession(ws)).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });
});
