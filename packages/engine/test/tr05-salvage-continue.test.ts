/**
 * TR-05：输出被砍断时，**保住已经完整到达的段落**，只补缺的那些。
 *
 * 现状是从零重来两次：
 *
 * - `llm-runtime`：没有正文 → 降思考档，整个请求重发；
 * - `translate-one.ts:642`：检测到截断 → `runBatches()` 重跑整章。
 *
 * 2026-08-12 的实测里那次被砍断的输出长这样：
 *
 *     <paragraph id="p0088">…完整的一段译文…</paragraph><paragraph id="p0089
 *
 * p0088 完好无损地到了，然后被扔掉重译。ch003 那 380 秒就是这么烧的——
 * 三次从零开始，每次把整份预算重烧一遍。
 *
 * 段落门禁协议 `<paragraph id="pNNNN">` 恰好给了**精确无损**的续接边界：
 * 已闭合的留下，没闭合的重发。这既不是预先切分（盲猜），也不是从零重来（浪费）。
 */
import { describe, expect, test } from "vitest";
import { salvageTruncated } from "../src/translate-one.ts";

const ids = ["p0088", "p0089", "p0090"];

describe("salvageTruncated 捞取", () => {
  test("砍在半个开标签上：已闭合的那段留下，其余进待补", () => {
    const raw = '<paragraph id="p0088">第一段译文</paragraph><paragraph id="p0089';
    const result = salvageTruncated(raw, ids);
    expect(result.kept.map((p) => p.id)).toEqual(["p0088"]);
    expect(result.kept[0]!.text).toBe("第一段译文");
    expect(result.missing).toEqual(["p0089", "p0090"]);
  });

  test("砍在段落正文中间：那一段整段作废，不留半句译文", () => {
    const raw = '<paragraph id="p0088">完整</paragraph><paragraph id="p0089">写到一半就断';
    const result = salvageTruncated(raw, ids);
    expect(result.kept.map((p) => p.id)).toEqual(["p0088"]);
    // 半句译文比没有更糟：它会以「已翻译」的身份混进正文
    expect(result.missing).toEqual(["p0089", "p0090"]);
  });

  test("全部完整到达时 missing 为空——这条路不该在正常情况下多做事", () => {
    const raw = ids.map((id) => `<paragraph id="${id}">译</paragraph>`).join("");
    const result = salvageTruncated(raw, ids);
    expect(result.kept).toHaveLength(3);
    expect(result.missing).toEqual([]);
  });

  test("一个字都没吐出来时全进待补，不抛异常", () => {
    const result = salvageTruncated("", ids);
    expect(result.kept).toEqual([]);
    expect(result.missing).toEqual(ids);
  });

  test("空正文的段落算没到——空译文会以「已翻译」的身份在正文里留个洞（RV-01 同类）", () => {
    const raw = '<paragraph id="p0088"></paragraph><paragraph id="p0089">有内容</paragraph>';
    const result = salvageTruncated(raw, ids);
    expect(result.kept.map((p) => p.id)).toEqual(["p0089"]);
    expect(result.missing).toEqual(["p0088", "p0090"]);
  });

  test("不在预期内的 id 一律不收——模型编出来的段落不能混进正文", () => {
    const raw = '<paragraph id="p0088">真</paragraph><paragraph id="p9999">假</paragraph>';
    const result = salvageTruncated(raw, ids);
    expect(result.kept.map((p) => p.id)).toEqual(["p0088"]);
    expect(result.missing).toEqual(["p0089", "p0090"]);
  });

  test("同一 id 出现两次只认第一次，不产生重复段落", () => {
    const raw = '<paragraph id="p0088">先</paragraph><paragraph id="p0088">后</paragraph>';
    const result = salvageTruncated(raw, ids);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]!.text).toBe("先");
  });

  test("乱序到达也按预期顺序排好——续译合并时顺序是正文的正确性，不是风格", () => {
    const raw = '<paragraph id="p0090">丙</paragraph><paragraph id="p0088">甲</paragraph>';
    const result = salvageTruncated(raw, ids);
    expect(result.kept.map((p) => p.id)).toEqual(["p0088", "p0090"]);
    expect(result.missing).toEqual(["p0089"]);
  });
});
