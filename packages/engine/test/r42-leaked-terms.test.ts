/**
 * R4-2 待审术语下沉到代码。
 *
 * 实测依据：真实模型翻译一章，6 个术语表外的角色名共出现 53 次，
 * 【待审:】标记产出 **0 个**。指望模型主动标注这条路是不通的。
 */
import { describe, expect, it } from "vitest";
import { collectLeakedTerms } from "../src/pending-terms.ts";

const pairs = (rows: Array<[string, string]>) => rows.map(([source, translation]) => ({ source, translation }));

describe("collectLeakedTerms", () => {
  it("译文里原样留下的片假名专名被收成待审候选", () => {
    const found = collectLeakedTerms(
      pairs([["ウィリアルドは溜め息をついた。", "ウィリアルド叹了口气。"]]),
      [],
      "ch003"
    );
    expect(found.map((t) => t.ja)).toEqual(["ウィリアルド"]);
    expect(found[0]!.chapterId).toBe("ch003");
    expect(found[0]!.context).toContain("ウィリアルド");
  });

  it("中点分隔的复合名按原文的完整形态收，而不是切成两半", () => {
    const found = collectLeakedTerms(
      pairs([["ピナ・ブランシュが現れた。", "ピナ・ブランシュ出现了。"]]),
      [],
      "ch003"
    );
    expect(found.map((t) => t.ja)).toEqual(["ピナ・ブランシュ"]);
  });

  it("禁翻表里的词不进队列（作者已经决定原样保留）", () => {
    expect(collectLeakedTerms(pairs([["スキルを使った。", "使用了スキル。"]]), [{ ja: "スキル" }], "ch1")).toEqual([]);
  });

  it("整段未译不算泄漏（那是漏译，另有检查负责）", () => {
    const src = "夜の八時前。俺たちは少し遅めの夕食をとっていた。";
    expect(collectLeakedTerms(pairs([[src, src]]), [], "ch1")).toEqual([]);
  });

  it("同一个词在多段出现只收一次", () => {
    const found = collectLeakedTerms(
      pairs([
        ["クロードが来た。", "クロード来了。"],
        ["クロードは笑った。", "クロード笑了。"],
      ]),
      [],
      "ch1"
    );
    expect(found).toHaveLength(1);
  });

  it("译文干净时零产出", () => {
    expect(collectLeakedTerms(pairs([["ウィリアルドは溜め息をついた。", "威利亚尔德叹了口气。"]]), [], "ch1")).toEqual([]);
  });

  it("译注括注里的假名不算泄漏", () => {
    expect(collectLeakedTerms(
      pairs([["桧山灯と灯ヒナは同音だ。", "桧山灯和小灯同音。（译：桧山灯（ひやま あかり）和灯ヒナ同音）"]]),
      [],
      "ch1"
    )).toEqual([]);
  });
});

describe("R4-2 生产路径", () => {
  it("整章翻译后，泄漏的专名自动进待审队列（不依赖模型标注）", async () => {
    const { mkdtemp, rm, writeFile, mkdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { createWorkspace } = await import("../src/workspace.ts");
    const { translateChapterToFile } = await import("../src/translate-one.ts");

    const dir = await mkdtemp(join(tmpdir(), "lightee-r42-"));
    try {
      const ws = await createWorkspace(dir, { name: "泄漏收割" });
      await mkdir(join(dir, "source", "v01"), { recursive: true });
      await mkdir(join(dir, "translations", "v01"), { recursive: true });
      await mkdir(join(dir, "terminology"), { recursive: true });
      await writeFile(join(dir, "source", "v01", "ch001.md"), "ウィリアルドは溜め息をついた。\n\nピナ・ブランシュが現れた。", "utf-8");
      await writeFile(
        join(dir, "source", "manifest.json"),
        JSON.stringify({ book: "t", chapters: [{ id: "ch001", title: "第1章", volume: "v01" }] })
      );
      // 模型照抄专名、且一个【待审:】都不写 —— 这正是实测到的行为
      const llm = {
        complete: async (_m: string, messages: Array<{ role: string; content: string }>) => {
          const ids = [...messages[messages.length - 1]!.content.matchAll(/<paragraph id="([^"]+)"/g)].map((x) => x[1]!);
          const texts = ["ウィリアルド叹了口气。", "ピナ・ブランシュ出现了。"];
          return { text: ids.map((id, i) => `<paragraph id="${id}">${texts[i] ?? "译文"}</paragraph>`).join("\n") };
        },
      };
      const result = await translateChapterToFile(ws, "ch001", llm as never, {
        project: { name: "t", srcLang: "ja", tgtLang: "zh" },
        agents: {},
        translation: { mode: "balanced", concurrency: 1, batchChars: 2000 },
      } as never);

      expect(result.translation).not.toContain("【待审:");
      expect(result.pendingTerms.map((t) => t.ja).sort()).toEqual(["ウィリアルド", "ピナ・ブランシュ"]);
      const saved = JSON.parse(await readFile(join(dir, "state", "pending-terms.json"), "utf-8")) as Array<{ ja: string }>;
      expect(saved.map((t) => t.ja).sort()).toEqual(["ウィリアルド", "ピナ・ブランシュ"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
