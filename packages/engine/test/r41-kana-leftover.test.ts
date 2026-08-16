/**
 * R4-1 残留假名检查：译文里留着的日文专名。
 *
 * 真实读数（本书 ch003 一次真实翻译）：244 个片假名字符留在中文译文里，
 * 6 个角色名共出现 53 次全部未译，而既有的 untranslated 检查一条都没报——
 * 它按整行假名比例判定，一个名字混在中文句里远达不到 0.35。
 */
import { describe, expect, it } from "vitest";
import { scanAllChapters, type ScanChapterInput } from "../src/reviewer-scan.ts";

function withParas(paragraphs: Array<{ id: string; source: string; translation: string }>): ScanChapterInput[] {
  return [{
    id: "ch001",
    source: paragraphs.map((p) => p.source).join("\n\n"),
    translation: paragraphs.map((p) => p.translation).join("\n\n"),
    paragraphs,
  }];
}
const types = (input: ScanChapterInput[]) => scanAllChapters(input).map((i) => i.type);

describe("R4-1 残留假名", () => {
  it("中文句子里夹着未译的片假名专名 → medium", () => {
    const issues = scanAllChapters(withParas([{
      id: "p0001",
      source: "ウィリアルドは溜め息をついた。彼は納得していない。",
      translation: "ウィリアルド叹了口气。他并不认同。",
    }]));
    const hit = issues.find((i) => i.type === "kana_leftover");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("medium");
    expect(hit!.found).toContain("ウィリアルド");
  });

  it("同段多个残留词一并列出，不刷屏", () => {
    const issues = scanAllChapters(withParas([{
      id: "p0001",
      source: "クロードとデイビッドが来た。",
      translation: "クロード和デイビッド来了。",
    }]));
    const hit = issues.find((i) => i.type === "kana_leftover")!;
    expect(hit.found).toContain("クロード");
    expect(hit.found).toContain("デイビッド");
    expect(issues.filter((i) => i.type === "kana_leftover")).toHaveLength(1);
  });

  it("禁翻表里的词不算残留（作者要求原样保留）", () => {
    const issues = scanAllChapters(
      withParas([{ id: "p0001", source: "スキルを使った。", translation: "使用了スキル。" }]),
      "zh",
      [],
      { noTranslate: [{ ja: "スキル" }] }
    );
    expect(issues.filter((i) => i.type === "kana_leftover")).toHaveLength(0);
  });

  it("整段未译由 untranslated 负责，不重复报", () => {
    const issues = scanAllChapters(withParas([{
      id: "p0001",
      source: "夜の八時前。俺たちは少し遅めの夕食をとっていた。",
      translation: "夜の八時前。俺たちは少し遅めの夕食をとっていた。",
    }]));
    expect(issues.filter((i) => i.type === "kana_leftover")).toHaveLength(0);
    expect(issues.map((i) => i.type)).toContain("untranslated");
  });

  it("正常中文译文零命中", () => {
    expect(types(withParas([{
      id: "p0001",
      source: "ウィリアルドは溜め息をついた。",
      translation: "威利亚尔德叹了口气。",
    }]))).not.toContain("kana_leftover");
  });

  it("单个假名不报（拟声词的中文化残留由别处负责，这里只抓成词的专名）", () => {
    expect(types(withParas([{
      id: "p0001",
      source: "あっと声を上げた。",
      translation: "他ア地叫了一声。",
    }]))).not.toContain("kana_leftover");
  });
});
