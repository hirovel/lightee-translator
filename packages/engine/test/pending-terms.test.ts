import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { extractPendingTerms, readPendingTerms, recordPendingTerms } from "../src/pending-terms.ts";

async function workspace() {
  const root = mkdtempSync(join(tmpdir(), "pending-terms-"));
  await mkdir(join(root, "state"), { recursive: true });
  return { root };
}

describe("新术语标记提取", () => {
  it("提取【待审:原文】标记——这是提示词与所有消费方共同的格式", () => {
    const terms = extractPendingTerms("他打开了道具箱【待审:アイテムボックス】。\n技能【待审:スキル】发动。", "ch001");
    expect(terms.map((t) => t.ja)).toEqual(["アイテムボックス", "スキル"]);
    expect(terms[0]!.chapterId).toBe("ch001");
    expect(terms[0]!.context).toContain("道具箱");
  });

  it("同一词多次出现只登记一条", () => {
    const terms = extractPendingTerms("【待审:スキル】……又见【待审:スキル】。");
    expect(terms).toHaveLength(1);
  });

  it("圆括号写法不算标记——格式不统一正是此前收割落空的原因", () => {
    expect(extractPendingTerms("道具箱（待审: アイテムボックス）")).toEqual([]);
  });

  it("无标记的译文返回空", () => {
    expect(extractPendingTerms("一段普通译文。")).toEqual([]);
  });
});

describe("新术语落盘", () => {
  it("已在术语档案里的词不再登记", async () => {
    const ws = await workspace();
    const added = await recordPendingTerms(
      ws,
      extractPendingTerms("【待审:アリス】与【待审:スキル】", "ch001"),
      new Set(["アリス"])
    );
    expect(added.map((t) => t.ja)).toEqual(["スキル"]);
  });

  it("跨章累积且不重复登记同一词", async () => {
    const ws = await workspace();
    await recordPendingTerms(ws, extractPendingTerms("【待审:スキル】", "ch001"), new Set());
    const second = await recordPendingTerms(ws, extractPendingTerms("【待审:スキル】", "ch002"), new Set());
    expect(second).toEqual([]);
    expect(await readPendingTerms(ws)).toHaveLength(1);
  });

  it("全部为已知词时不写盘", async () => {
    const ws = await workspace();
    const added = await recordPendingTerms(ws, extractPendingTerms("【待审:アリス】"), new Set(["アリス"]));
    expect(added).toEqual([]);
    expect(await readPendingTerms(ws)).toEqual([]);
  });
});

/**
 * 词条类型 → 档案路由（`cardTypeFor`）。
 *
 * 这条链从前是断的：卡片类型硬编码 `"term"`，模型给的 type 只作为 metadata 留个念想。
 * 于是人名全堆在 terms 里，而**双关一个都进不了 puns 档案**——`buildChapterPunBlock`
 * （后续章节自动带译注）与 `pun_note_missing` 检查都挂在 puns 上，等于结构上不可能触发。
 *
 * 2026-08-12 单章实测是判据：模型把谐音昵称识别对、译法取对，就是没加译注，
 * 而本该兜住它的检查因为词进不了档案，一次都没响。
 */
describe("词条类型决定落进哪个档案", () => {
  const promote = async () => {
    const { promotePendingTerms } = await import("../src/pending-terms.ts");
    const { loadSession } = await import("../src/confirm-session.ts");
    return { promotePendingTerms, loadSession };
  };

  it("person → name 卡（确认后进 names.json，不再堆进 terms）", async () => {
    const ws = await workspace();
    const { promotePendingTerms, loadSession } = await promote();
    await recordPendingTerms(ws, [{ ja: "桧山灯", zh: "桧山灯", type: "person", context: "", chapterId: "ch001" }], new Set());
    await promotePendingTerms(ws);
    const card = (await loadSession(ws))?.cards.find((c) => c.ja === "桧山灯");
    expect(card?.type).toBe("name");
  });

  it("pun → pun 卡（确认后进 puns.json，双关注入与译注检查才接得上）", async () => {
    const ws = await workspace();
    const { promotePendingTerms, loadSession } = await promote();
    await recordPendingTerms(ws, [{ ja: "灯ヒナ", zh: "小灯", type: "pun", context: "", chapterId: "ch001" }], new Set());
    await promotePendingTerms(ws);
    const card = (await loadSession(ws))?.cards.find((c) => c.ja === "灯ヒナ");
    expect(card?.type).toBe("pun");
  });

  it("其余类型合并进 terms——档案只有三个出口，宁可少分不可分错", async () => {
    const ws = await workspace();
    const { promotePendingTerms, loadSession } = await promote();
    await recordPendingTerms(ws, [
      { ja: "リンドブルム", zh: "林德布鲁姆", type: "place", context: "", chapterId: "ch001" },
      { ja: "星の乙女", zh: "星之乙女", type: "title", context: "", chapterId: "ch001" },
    ], new Set());
    await promotePendingTerms(ws);
    const cards = (await loadSession(ws))?.cards ?? [];
    expect(cards.map((c) => c.type)).toEqual(["term", "term"]);
  });

  it("没有 type（内联标记来源）→ term，不猜", async () => {
    const ws = await workspace();
    const { promotePendingTerms, loadSession } = await promote();
    await recordPendingTerms(ws, [{ ja: "スキル", context: "", chapterId: "ch001" }], new Set());
    await promotePendingTerms(ws);
    expect((await loadSession(ws))?.cards.find((c) => c.ja === "スキル")?.type).toBe("term");
  });
});

/**
 * 卡片的 note 就是**印给读者看的译注**：pun 卡确认后进 puns.json 的 note，
 * 后续章节的双关档案块照着它写成（译注: …）。
 *
 * 三个真实工作区的 puns.json 里存的全是一句代填文本
 * （「译者在 ch001 翻译本章时登记的新术语（pun）。」），而模型给的真解释躺在 context 里。
 * 下一章会照着那句话往正文里印。
 */
describe("译注内容只能来自模型，不能由代码代填", () => {
  const promote = async () => {
    const { promotePendingTerms } = await import("../src/pending-terms.ts");
    const { loadSession } = await import("../src/confirm-session.ts");
    return { promotePendingTerms, loadSession };
  };

  it("模型给了说明 → 原样进 note", async () => {
    const ws = await workspace();
    const { promotePendingTerms, loadSession } = await promote();
    await recordPendingTerms(ws, [{
      ja: "灯ヒナ", zh: "小灯", type: "pun", chapterId: "ch001",
      context: "「じゃあ灯ヒナって呼んでいいよ」",
      note: "「桧山灯」的「比奈（ひな）」与「雏」同音",
    }], new Set());
    await promotePendingTerms(ws);
    const card = (await loadSession(ws))?.cards.find((c) => c.ja === "灯ヒナ");
    expect(card?.note).toBe("「桧山灯」的「比奈（ひな）」与「雏」同音");
    // context 是首现上下文，不是说明的备胎
    expect(card?.context).toBe("「じゃあ灯ヒナって呼んでいいよ」");
  });

  it("模型没给说明 → note 留空，绝不现编一句", async () => {
    const ws = await workspace();
    const { promotePendingTerms, loadSession } = await promote();
    await recordPendingTerms(ws, [{ ja: "灯ヒナ", zh: "小灯", type: "pun", context: "", chapterId: "ch001" }], new Set());
    await promotePendingTerms(ws);
    const card = (await loadSession(ws))?.cards.find((c) => c.ja === "灯ヒナ");
    expect(card?.note).toBeUndefined();
  });

  it("任何卡片的 note 里都不出现「登记的新术语」这类关于软件自己的话", async () => {
    const ws = await workspace();
    const { promotePendingTerms, loadSession } = await promote();
    await recordPendingTerms(ws, [
      { ja: "灯ヒナ", zh: "小灯", type: "pun", context: "", chapterId: "ch001" },
      { ja: "スキル", context: "", chapterId: "ch001" },
    ], new Set());
    await promotePendingTerms(ws);
    for (const card of (await loadSession(ws))?.cards ?? []) {
      expect(card.note ?? "").not.toMatch(/登记的新术语|译者在/);
    }
  });
});

describe("firstOccurrence（首现上下文）", () => {
  it("取词在原文里的前后各 30 字", async () => {
    const { firstOccurrence } = await import("../src/pending-terms.ts");
    const source = `${"あ".repeat(50)}灯ヒナ${"い".repeat(50)}`;
    const excerpt = firstOccurrence(source, "灯ヒナ");
    expect(excerpt).toBe(`${"あ".repeat(30)}灯ヒナ${"い".repeat(30)}`);
  });

  it("原文里没有这个词 → 空串，不凑一段不含它的上下文", async () => {
    const { firstOccurrence } = await import("../src/pending-terms.ts");
    expect(firstOccurrence("窓の外は雨だった。", "灯ヒナ")).toBe("");
  });
});
