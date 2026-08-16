import { describe, expect, it } from "vitest";
import { ParagraphDocument } from "./paragraph-document.js";

describe("ParagraphDocument", () => {
  it("maps paragraph ids and text positions across blank-line separators", () => {
    const document = ParagraphDocument.fromParagraphs([
      { id: "p0001", text: "第一段" },
      { id: "p0002", text: "第二段" },
    ]);

    expect(document.text).toBe("第一段\n\n第二段");
    expect(document.paragraphAt(1).id).toBe("p0001");
    expect(document.paragraphAt(5).id).toBe("p0002");
    expect(document.paragraphById("p0002")).toMatchObject({ start: 5, end: 8 });
  });

  it("splits and merges while preserving stable ids", () => {
    const original = ParagraphDocument.fromParagraphs([{ id: "p0001", text: "甲乙" }]);
    const split = original.split(0, 1, "p0002");
    expect(split.toJSON()).toEqual([
      { id: "p0001", text: "甲" },
      { id: "p0002", text: "乙" },
    ]);
    expect(split.merge(1).toJSON()).toEqual([{ id: "p0001", text: "甲乙" }]);
  });

  it("moves paragraphs and reconciles their stable ids", () => {
    const original = ParagraphDocument.fromParagraphs([
      { id: "p0001", text: "甲" },
      { id: "p0002", text: "乙" },
      { id: "p0003", text: "丙" },
    ]);
    const moved = original.move(1, 1);
    expect(moved.toJSON()).toEqual([
      { id: "p0001", text: "甲" },
      { id: "p0003", text: "丙" },
      { id: "p0002", text: "乙" },
    ]);
    expect(original.reconcile(moved.text, { kind: "move", paragraphId: "p0002", toIndex: 2 }).toJSON()).toEqual(moved.toJSON());
  });

  it("reconciles a flat editor document after a structural operation", () => {
    const original = ParagraphDocument.fromParagraphs([{ id: "p0001", text: "甲乙" }]);
    const next = original.reconcile("甲\n\n乙", {
      kind: "split",
      paragraphId: "p0001",
      offset: 1,
      newParagraphId: "p0002",
    });
    expect(next.toJSON()).toEqual([
      { id: "p0001", text: "甲" },
      { id: "p0002", text: "乙" },
    ]);
  });
});
