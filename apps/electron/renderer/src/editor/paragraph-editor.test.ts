import { describe, expect, it } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { ParagraphDocument } from "./paragraph-document.js";
import { paragraphOperation, paragraphDocumentField, termHighlightDecorations } from "./paragraph-editor.js";

describe("paragraph editor transaction contract", () => {
  it("records split operations as a transaction annotation", () => {
    const state = EditorState.create({
      doc: "甲乙",
      extensions: [paragraphDocumentField.init(() => ParagraphDocument.fromParagraphs([{ id: "p0001", text: "甲乙" }]))],
    });
    const transaction = state.update({
      changes: { from: 1, insert: "\n\n" },
      annotations: [
        paragraphOperation.of({ kind: "split", paragraphId: "p0001", offset: 1, newParagraphId: "p0002" }),
        Transaction.userEvent.of("input.split-paragraph"),
      ],
    });
    expect(transaction.annotation(paragraphOperation)).toMatchObject({
      kind: "split",
      paragraphId: "p0001",
      newParagraphId: "p0002",
    });
  });
});

describe("术语高亮装饰", () => {
  // 事故回放：RangeSetBuilder 要求按 from 升序 add，而旧实现按「词」外层循环——
  // 第二个词的首次命中位于第一个词的末次命中之前就 throw。这个 throw 发生在
  // EditorState.create 内（termHighlightField.create），把翻译完成后的编辑器炸成空壳。
  it("多词乱序命中不抛错——第二个词出现在第一个词的更早位置", () => {
    const state = EditorState.create({ doc: "少女望着天使。少年也望着天使。少女笑了。" });
    const decorations = termHighlightDecorations(state, [
      { source: "てんし", target: "天使" },
      { source: "しょうじょ", target: "少女" },
      { source: "しょうねん", target: "少年" },
    ]);
    let count = 0;
    decorations.between(0, state.doc.length, () => { count += 1; });
    expect(count).toBe(5); // 天使×2 + 少女×2 + 少年×1
  });

  it("嵌套译名（蕾米 ⊂ 蕾米莉亚）同起点不同长度也不抛错", () => {
    const state = EditorState.create({ doc: "蕾米莉亚看着蕾米。" });
    const decorations = termHighlightDecorations(state, [
      { source: "レミ", target: "蕾米" },
      { source: "レミリア", target: "蕾米莉亚" },
    ]);
    let count = 0;
    decorations.between(0, state.doc.length, () => { count += 1; });
    expect(count).toBe(3); // 蕾米莉亚×1 + 蕾米×2（其中一次嵌在长名里）
  });
});
