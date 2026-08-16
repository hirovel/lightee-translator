/**
 * 审校问题的就地标注（RV-05）。
 *
 * 作者的动线是顺着译文往下读，问题就该出现在眼睛所在的地方——而不是只躺在一份
 * 索引列表里等人对号入座。这里按**段落 id** 给对应的行加一个 line decoration，
 * 视觉上只是左缘一道细线，不打断阅读。
 *
 * 只做标注，不做修改：改译文是作者在正文里自己动手的事（R3-2 人改保护的边界不碰）。
 */
import { EditorState, StateEffect, StateField, RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { paragraphDocumentField } from "./paragraph-editor.js";

/** 一段上的问题严重度。同一段有多条时取最重的一条着色。 */
export type IssueSeverity = "high" | "medium" | "low";

export const setIssueMarksEffect = StateEffect.define<Record<string, IssueSeverity>>();

const LINE_DECORATIONS: Record<IssueSeverity, Decoration> = {
  high: Decoration.line({ class: "lightee-issue-line lightee-issue-high" }),
  medium: Decoration.line({ class: "lightee-issue-line lightee-issue-medium" }),
  low: Decoration.line({ class: "lightee-issue-line lightee-issue-low" }),
};

function buildDecorations(state: EditorState, marks: Record<string, IssueSeverity>): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const ids = Object.keys(marks);
  if (ids.length === 0) return builder.finish();
  const document = state.field(paragraphDocumentField);
  // 逐段取范围，再把范围内的每一行打上标记（一段可能有多行软换行）。
  // 按行号升序添加是 RangeSetBuilder 的硬性要求，所以先收集再排序。
  const lines: Array<{ from: number; severity: IssueSeverity }> = [];
  for (const range of document.ranges()) {
    const severity = marks[range.id];
    if (!severity) continue;
    let lineNumber = state.doc.lineAt(Math.min(range.start, state.doc.length)).number;
    const lastLine = state.doc.lineAt(Math.min(range.end, state.doc.length)).number;
    for (; lineNumber <= lastLine; lineNumber += 1) {
      lines.push({ from: state.doc.line(lineNumber).from, severity });
    }
  }
  lines.sort((a, b) => a.from - b.from);
  for (const line of lines) builder.add(line.from, line.from, LINE_DECORATIONS[line.severity]);
  return builder.finish();
}

/**
 * 标注状态。文档一改就清空——作者动过的段落，上一次检查的结论已经不作数了；
 * 继续显示旧标记会让人以为「改完还是有问题」。
 */
export const issueMarksField = StateField.define<{ marks: Record<string, IssueSeverity>; decorations: DecorationSet }>({
  create: () => ({ marks: {}, decorations: Decoration.none }),
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setIssueMarksEffect)) {
        return { marks: effect.value, decorations: buildDecorations(transaction.state, effect.value) };
      }
    }
    if (transaction.docChanged) return { marks: {}, decorations: Decoration.none };
    return value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

export function setIssueMarks(view: EditorView, marks: Record<string, IssueSeverity>): void {
  view.dispatch({ effects: setIssueMarksEffect.of(marks) });
}

/** 把光标移到某一段并滚到视野中央（索引列表点击 → 正文定位）。 */
export function revealParagraph(view: EditorView, paragraphId: string): boolean {
  const range = view.state.field(paragraphDocumentField).paragraphById(paragraphId);
  if (!range) return false;
  const position = Math.min(range.start, view.state.doc.length);
  view.dispatch({
    selection: { anchor: position },
    effects: EditorView.scrollIntoView(position, { y: "center" }),
  });
  view.focus();
  return true;
}
