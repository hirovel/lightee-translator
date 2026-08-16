import { describe, expect, it } from "vitest";
import { editorFootBar, FOOT_COUNT_SELECTOR } from "./editor-foot-bar.js";

const bar = (over: Partial<Parameters<typeof editorFootBar>[0]> = {}): string =>
  editorFootBar({
    chapterId: "ch001",
    meta: "125 段",
    stateId: "save-hint",
    stateLabel: "无改动",
    keys: [
      { keys: ["Ctrl", "S"], label: "保存" },
      { keys: ["Ctrl", "↑", "↓"], label: "跳过空行", optional: true },
    ],
    ...over,
  });

/** 取出 `<span class="editor-foot-meta">…</span>` 里的内容 */
function metaCell(html: string): string {
  const match = /<span class="editor-foot-meta">(.*?)<\/span><span class="editor-foot-shortcut">/s.exec(html);
  if (!match) throw new Error("底栏身份格不见了");
  return match[1]!;
}

describe("章节底栏", () => {
  it("段数那格带自己的类名，能被 FOOT_COUNT_SELECTOR 定位", () => {
    const html = bar();
    expect(FOOT_COUNT_SELECTOR).toContain("efoot-count");
    expect(html.match(/class="efoot-count"/g)).toHaveLength(1);
    expect(html).toContain(`<span class="efoot-count">125 段</span>`);
  });

  // 这条钉的是一次真实的回归：自动保存靠「.editor-foot-meta 里的第一个 span」写段数，
  // 后来插进来的分隔线正好排在段数前面，于是「N 段」被写进那条 1px 宽的竖线里，
  // 溢出来盖在真正的段数上——作者看到的是底栏有一层重影。位置不是身份，类名才是。
  it("身份格里的第一个 span 是分隔线而不是段数，所以不许按位置取", () => {
    const cell = metaCell(bar());
    const firstSpan = /<span[^>]*>/.exec(cell)?.[0];
    expect(firstSpan).toContain("efoot-rule");
    expect(firstSpan).not.toContain("efoot-count");
  });

  it("分隔线是空的，装不下也不该装内容", () => {
    expect(metaCell(bar())).toContain(`<span class="efoot-rule" aria-hidden="true"></span>`);
  });

  it("键盘参考不挂悬停提示", () => {
    expect(bar()).not.toContain("title=");
  });

  it("可选键组带 data-optional，窄容器才摘得掉", () => {
    const html = bar();
    expect(html).toContain(`<span class="efoot-key" data-optional>`);
    expect(html).toContain(`<span class="efoot-key">`);
  });

  it("插值一律转义", () => {
    const html = bar({ chapterId: `ch<"1">`, meta: "1 & 2 段" });
    expect(html).toContain("ch&lt;&quot;1&quot;&gt;");
    expect(html).toContain("1 &amp; 2 段");
    expect(html).not.toContain(`ch<"1">`);
  });
});
