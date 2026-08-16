import { describe, expect, it } from "vitest";
import { currentVolumeId } from "./volume-highlight.js";

/** 合本书形态（EV-01）：多卷、卷内多章、分节标题可重复 */
const volumes = [
  { id: "v01", chapters: [{ id: "ch001" }, { id: "ch002" }, { id: "ch003" }, { id: "ch004" }] },
  { id: "v02", chapters: [{ id: "ch005" }, { id: "ch006" }] },
  { id: "v03", chapters: [] },
  { id: "v04", chapters: [{ id: "ch007" }] },
];

describe("currentVolumeId", () => {
  it("第三章往后一样定位得到所属卷——不是只有头两章才对", () => {
    expect(currentVolumeId(volumes, "ch001")).toBe("v01");
    expect(currentVolumeId(volumes, "ch003")).toBe("v01");
    expect(currentVolumeId(volumes, "ch004")).toBe("v01");
    expect(currentVolumeId(volumes, "ch006")).toBe("v02");
    expect(currentVolumeId(volumes, "ch007")).toBe("v04");
  });

  it("空卷不吞掉判定", () => {
    expect(currentVolumeId(volumes, "ch007")).toBe("v04");
  });

  it("章节不存在或未指定 → null（调用方据此清空高亮）", () => {
    expect(currentVolumeId(volumes, "ch999")).toBeNull();
    expect(currentVolumeId(volumes, null)).toBeNull();
    expect(currentVolumeId(volumes, undefined)).toBeNull();
    expect(currentVolumeId(volumes, "")).toBeNull();
    expect(currentVolumeId([], "ch001")).toBeNull();
  });

  it("同名分节按 id 区分：合本书的多段「幕間」不会互相顶替", () => {
    // EV-01：卷 label 可以重复（幕間×3），id 唯一——判定必须走 id
    const serial = [
      { id: "v02", chapters: [{ id: "ch034" }] },
      { id: "v05", chapters: [{ id: "ch078" }] },
    ];
    expect(currentVolumeId(serial, "ch078")).toBe("v05");
    expect(currentVolumeId(serial, "ch034")).toBe("v02");
  });
});
