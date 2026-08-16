import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  planRename,
  applyRenamePlan,
  retroRename,
  readRenameReview,
  resolveRenameReview,
  checkRenameGate,
  claimOccurrences,
  overlapsOtherTerm,
} from "../src/rename-repair.ts";
import { readChapterParagraphs, writeChapterParagraphs, type ChapterParagraph } from "../src/paragraph-gate.ts";
import type { Workspace } from "../src/workspace.ts";

async function makeWorkspace(chapters: Array<{ id: string; paragraphs: ChapterParagraph[] }>): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "lightee-rename-"));
  const ws = { root } as Workspace;
  await mkdir(join(root, "source", "v01"), { recursive: true });
  await writeFile(
    join(root, "source", "manifest.json"),
    JSON.stringify({ chapters: chapters.map((c) => ({ id: c.id, volume: "v01" })) }),
    "utf-8",
  );
  for (const chapter of chapters) {
    await writeChapterParagraphs(ws, chapter.id, chapter.paragraphs, { staging: false });
  }
  return ws;
}

const para = (id: string, translation: string, extra: Partial<ChapterParagraph> = {}): ChapterParagraph => ({
  id,
  type: "body",
  source: "原文",
  translation,
  ...extra,
});

describe("追溯改名窄门（EX-06）", () => {
  it("窄门内：旧译名逐处自动替换，并留下复查标记", async () => {
    const ws = await makeWorkspace([
      { id: "ch001", paragraphs: [para("p0001", "雏菜笑了。雏菜没有回头。"), para("p0002", "他看着她。")] },
    ]);

    const result = await retroRename(ws, { ja: "ヒナギク", oldZh: "雏菜", newZh: "雏", otherZh: ["星之圣女"] });

    expect(result.blocked).toBeUndefined();
    expect(result.replaced).toBe(1);
    expect(result.review).toHaveLength(0);

    const file = await readChapterParagraphs(ws, "ch001");
    expect(file?.paragraphs[0]?.translation).toBe("雏笑了。雏没有回头。");
    expect(file?.paragraphs[0]?.recheck?.reason).toContain("雏菜 → 雏");
    // 没出现旧译名的段落不该被碰，更不该被打上复查标记
    expect(file?.paragraphs[1]?.translation).toBe("他看着她。");
    expect(file?.paragraphs[1]?.recheck).toBeUndefined();
  });

  it("单字旧译名仍被 too_short 挡下：零自动替换，全部进复查队列", async () => {
    const ws = await makeWorkspace([
      { id: "ch001", paragraphs: [para("p0001", "雏点了点头，雏菜站在门口。")] },
    ]);

    const result = await retroRename(ws, { ja: "ヒナ", oldZh: "雏", newZh: "小雏", otherZh: ["雏菜"] });

    expect(result.blocked).toBe("too_short");
    expect(result.replaced).toBe(0);
    expect(result.review).toHaveLength(1);

    const file = await readChapterParagraphs(ws, "ch001");
    expect(file?.paragraphs[0]?.translation).toBe("雏点了点头，雏菜站在门口。");

    const queue = await readRenameReview(ws);
    expect(queue.entries).toHaveLength(1);
    expect(queue.entries[0]?.chapterId).toBe("ch001");
    expect(queue.entries[0]?.excerpt).toContain("雏");
  });

  // ===== TP-3 连带改名：子串包含不再全局封锁 =====
  // 12 章实测里 substring_of_term 拦下了 16%（14/87，含 3 个双字人名）。
  // 被更长词条占住的位置是**那个词的一部分**，跳过它是确定性判断，不需要人。

  it("TP-3：旧译名是其他译名的子串 → 不再全局封锁；占位处跳过、自由处替换", async () => {
    const ws = await makeWorkspace([
      { id: "ch001", paragraphs: [para("p0001", "圣女点了点头，星之圣女站在门口。")] },
    ]);

    const result = await retroRename(ws, { ja: "セイジョ", oldZh: "圣女", newZh: "神女", otherZh: ["星之圣女"] });

    expect(result.blocked).toBeUndefined();
    expect(result.replaced).toBe(1);
    expect(result.review).toHaveLength(0);

    const file = await readChapterParagraphs(ws, "ch001");
    // 「星之圣女」里的「圣女」是那个词的一部分——一个字都不动
    expect(file?.paragraphs[0]?.translation).toBe("神女点了点头，星之圣女站在门口。");
  });

  it("TP-3：全部出现都被更长词条占住的段落，不进 auto 也不进复查——改名与它无关", async () => {
    const ws = await makeWorkspace([
      { id: "ch001", paragraphs: [para("p0001", "星之圣女站在门口。"), para("p0002", "圣女回头。")] },
    ]);

    const plan = await planRename(ws, { ja: "セイジョ", oldZh: "圣女", newZh: "神女", otherZh: ["星之圣女"] });

    expect(plan.auto.map((hit) => hit.paragraphId)).toEqual(["p0002"]);
    expect(plan.review).toHaveLength(0);
  });

  it("TP-3：先长后短——嵌套包含时最长词条的占位覆盖一切", () => {
    // 表里同时有「星之圣女」与「星之圣女团」：文本里的「星之圣女团」由最长者占位，
    // 其中的「圣女」不可替换；旁边独立的「圣女」照常
    const claims = claimOccurrences("星之圣女团来了，圣女在后。", "圣女", ["星之圣女", "星之圣女团"]);
    expect(claims.claimed).toEqual([2]);
    expect(claims.free).toEqual([8]);
    expect(claims.contested).toEqual([]);
  });

  it("TP-3：部分咬合仍进复查——占位判定只放行完全包含", () => {
    // 「星之圣」与「圣女」在「星之圣女」处互相咬住一截：不是谁的一部分，人裁
    const claims = claimOccurrences("星之圣女走了过来。", "圣女", ["星之圣"]);
    expect(claims.contested).toEqual([2]);
    expect(claims.free).toEqual([]);
  });

  it("TP-3：checkRenameGate 只剩长度一道判据", () => {
    expect(checkRenameGate("圣女")).toBeUndefined();
    expect(checkRenameGate("雏")).toBe("too_short");
  });

  it("人改保护段不被触碰，进复查队列", async () => {
    const ws = await makeWorkspace([
      {
        id: "ch001",
        paragraphs: [
          para("p0001", "雏菜笑了。"),
          para("p0002", "雏菜转过身。", { translatedBy: "human" }),
        ],
      },
    ]);

    const result = await retroRename(ws, { ja: "ヒナギク", oldZh: "雏菜", newZh: "雏", otherZh: [] });

    expect(result.replaced).toBe(1);
    expect(result.review.map((item) => item.reason)).toEqual(["human_edited"]);

    const file = await readChapterParagraphs(ws, "ch001");
    expect(file?.paragraphs[0]?.translation).toBe("雏笑了。");
    expect(file?.paragraphs[1]?.translation).toBe("雏菜转过身。");
    expect(file?.paragraphs[1]?.translatedBy).toBe("human");
  });

  it("段内与另一术语部分重叠 → 该段进复查，其余段照常自动替换", async () => {
    const ws = await makeWorkspace([
      {
        id: "ch001",
        // 「星之圣」与「圣女」在「星之圣女」处互相咬住一截
        paragraphs: [para("p0001", "星之圣女走了过来。"), para("p0002", "圣女站在原地。")],
      },
    ]);

    const plan = await planRename(ws, { ja: "セイジョ", oldZh: "圣女", newZh: "神女", otherZh: ["星之圣"] });

    expect(plan.blocked).toBeUndefined();
    expect(plan.review.map((item) => [item.paragraphId, item.reason])).toEqual([["p0001", "overlaps_term"]]);
    expect(plan.auto.map((item) => item.paragraphId)).toEqual(["p0002"]);
  });

  it("完全被旧译名包住的其他术语不算重叠", () => {
    // 整串「星之圣女」一起换掉，被包住的「圣女」不会残留
    expect(overlapsOtherTerm("星之圣女在此", "星之圣女", ["圣女"])).toBe(false);
    expect(overlapsOtherTerm("星之圣女在此", "圣女", ["星之圣"])).toBe(true);
  });

  it("没有段落权威文件的历史章节整章进复查，不改 md", async () => {
    const ws = await makeWorkspace([{ id: "ch001", paragraphs: [para("p0001", "无关内容。")] }]);
    // ch002 只有 manifest 与 md，没有 state/paragraphs
    await writeFile(
      join(ws.root, "source", "manifest.json"),
      JSON.stringify({ chapters: [{ id: "ch001", volume: "v01" }, { id: "ch002", volume: "v01" }] }),
      "utf-8",
    );
    await mkdir(join(ws.root, "translations"), { recursive: true });
    await writeFile(join(ws.root, "translations", "ch002_zh.md"), "雏菜在这里。\n", "utf-8");

    const result = await retroRename(ws, { ja: "ヒナギク", oldZh: "雏菜", newZh: "雏", otherZh: [] });

    expect(result.replaced).toBe(0);
    expect(result.review).toEqual([
      expect.objectContaining({ chapterId: "ch002", paragraphId: "*", reason: "no_paragraphs" }),
    ]);
    expect(await readFile(join(ws.root, "translations", "ch002_zh.md"), "utf-8")).toBe("雏菜在这里。\n");
  });

  it("同一处重复改名不在队列里堆条目；解决后可标记", async () => {
    const ws = await makeWorkspace([
      { id: "ch001", paragraphs: [para("p0001", "雏菜笑了。", { translatedBy: "human" })] },
    ]);
    const input = { ja: "ヒナギク", oldZh: "雏菜", newZh: "雏", otherZh: [] };

    await retroRename(ws, input);
    await retroRename(ws, input);

    const queue = await readRenameReview(ws);
    expect(queue.entries).toHaveLength(1);

    expect(await resolveRenameReview(ws, queue.entries[0]!.id)).toBe(true);
    expect(await resolveRenameReview(ws, queue.entries[0]!.id)).toBe(false);
    expect((await readRenameReview(ws)).entries[0]?.resolvedAt).toBeGreaterThan(0);
  });

  it("旧译名与新译名相同 → 什么都不做", async () => {
    const ws = await makeWorkspace([{ id: "ch001", paragraphs: [para("p0001", "雏菜笑了。")] }]);
    const plan = await planRename(ws, { ja: "ヒナギク", oldZh: "雏菜", newZh: "雏菜", otherZh: [] });
    expect(plan.auto).toHaveLength(0);
    expect(plan.review).toHaveLength(0);
    expect((await applyRenamePlan(ws, plan)).replaced).toBe(0);
  });
});
