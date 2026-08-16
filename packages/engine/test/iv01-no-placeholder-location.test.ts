/**
 * IV-01 / 家族 D（代理判据与占位值）—— 拿不到定位时不许伪造一个。
 *
 * RV-04 把**权威**定位（paragraphIds）改成了产出时记录、拿不到就留空。但展示串
 * `location` 还留着最后一层占位：段落数据缺席时它退回 `chXXX_zh.md:1`。
 * 那个 `1` 不是测出来的行号，是写死的常量——而 `resolveIssueParagraphIds` 会把
 * 它老老实实解析成第一段。于是「不知道在哪」被展示成、也被下游读成「在第一段」。
 *
 * 正确形态：不知道就只报文件名。下游反解得到空数组，局部修订因此按兵不动。
 */
import { describe, expect, it } from "vitest";
import { scanAllChapters, type ScanChapterInput } from "../src/reviewer-scan.ts";
import { resolveIssueParagraphIds } from "../src/chapter-pipeline.ts";

/** 引号跨段不配对：逐段自查都配对，整章数量对不上 → 定位不到具体段落 */
const UNPAIRED: ScanChapterInput[] = [
  {
    id: "ch001",
    source: "「おはよう\n\nと彼女は言った。",
    translation: "“早上好\n\n她说道。",
    // paragraphs 故意缺席：这正是「拿不到段落数据」的情形
  },
];

describe("IV-01 审校问题不得伪造定位", () => {
  it("段落数据缺席时 location 只报文件名，不写死 :1", () => {
    const issues = scanAllChapters(UNPAIRED);
    const broken = issues.find((issue) => issue.type === "dialogue_format");
    expect(broken).toBeDefined();
    expect(broken!.paragraphIds).toBeUndefined();
    expect(broken!.location).toBe("ch001_zh.md");
  });

  it("这样的 location 反解为空数组，而不是「第一段」", () => {
    const issues = scanAllChapters(UNPAIRED);
    const broken = issues.find((issue) => issue.type === "dialogue_format")!;
    const paragraphs = [
      { id: "p0001", translation: "“早上好" },
      { id: "p0002", translation: "她说道。" },
    ];
    expect(resolveIssueParagraphIds(paragraphs, broken.location)).toEqual([]);
  });
});
