/**
 * RV-05 就地标注：审校问题按段落 id 落到正文行上。
 *
 * 索引列表能独立交付，标注不能——它必须证明三件事：标对了段、一段多行都标到、
 * 作者一动手就撤掉（上一次检查的结论对改过的文字已经不作数）。
 */
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ParagraphDocument } from "./paragraph-document.js";
import { paragraphDocumentField } from "./paragraph-editor.js";
import { issueMarksField, setIssueMarksEffect } from "./issue-marks.js";

const PARAGRAPHS = [
  { id: "p0001", text: "第一段。" },
  { id: "p0002", text: "第二段上行\n第二段下行" },
  { id: "p0003", text: "第三段。" },
];

function stateWith(): EditorState {
  const document = ParagraphDocument.fromParagraphs(PARAGRAPHS);
  return EditorState.create({
    doc: document.text,
    extensions: [paragraphDocumentField.init(() => document), issueMarksField],
  });
}

/** 被标注的行号（1 起） */
function markedLines(state: EditorState): number[] {
  const lines: number[] = [];
  const decorations = state.field(issueMarksField).decorations;
  const cursor = decorations.iter();
  while (cursor.value) {
    lines.push(state.doc.lineAt(cursor.from).number);
    cursor.next();
  }
  return lines;
}

describe("RV-05 段落标注", () => {
  it("标在指定段落上，不波及邻段", () => {
    const state = stateWith();
    const next = state.update({ effects: setIssueMarksEffect.of({ p0003: "high" }) }).state;
    // 投影行：1=p0001 2=空 3/4=p0002 5=空 6=p0003
    expect(markedLines(next)).toEqual([6]);
  });

  it("一段多行时每一行都标到", () => {
    const state = stateWith();
    const next = state.update({ effects: setIssueMarksEffect.of({ p0002: "medium" }) }).state;
    expect(markedLines(next)).toEqual([3, 4]);
  });

  it("多段同时标注，按行号升序（RangeSetBuilder 的硬性要求）", () => {
    const state = stateWith();
    const next = state.update({ effects: setIssueMarksEffect.of({ p0003: "low", p0001: "high" }) }).state;
    expect(markedLines(next)).toEqual([1, 6]);
  });

  it("作者一改文档就撤掉标注——旧结论对改过的文字不作数", () => {
    const state = stateWith();
    const marked = state.update({ effects: setIssueMarksEffect.of({ p0001: "high" }) }).state;
    expect(markedLines(marked)).toHaveLength(1);
    const edited = marked.update({ changes: { from: 0, insert: "改" } }).state;
    expect(markedLines(edited)).toEqual([]);
    expect(edited.field(issueMarksField).marks).toEqual({});
  });

  it("空标注表不产生任何装饰", () => {
    const state = stateWith();
    const next = state.update({ effects: setIssueMarksEffect.of({}) }).state;
    expect(markedLines(next)).toEqual([]);
  });

  it("段落 id 对不上时安静跳过，不去猜相邻段", () => {
    const state = stateWith();
    const next = state.update({ effects: setIssueMarksEffect.of({ p9999: "high" }) }).state;
    expect(markedLines(next)).toEqual([]);
  });
});
