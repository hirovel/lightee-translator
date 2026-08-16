export const PARAGRAPH_SEPARATOR = "\n\n";

export interface Paragraph {
  id: string;
  text: string;
}

export interface ParagraphRange extends Paragraph {
  index: number;
  start: number;
  end: number;
  separatorStart: number;
  separatorEnd: number;
}

export type ParagraphOperation =
  | { kind: "line-break"; paragraphId: string; offset: number }
  | { kind: "split"; paragraphId: string; offset: number; newParagraphId: string }
  | { kind: "merge"; previousParagraphId: string; mergedParagraphId: string }
  | { kind: "move"; paragraphId: string; toIndex: number }
  | { kind: "replace"; reason: "input" | "paste" | "delete" | "ime" | "undo" | "redo" };

function generatedId(existing: ReadonlyArray<Paragraph>, prefix = "p"): string {
  const ids = new Set(existing.map((paragraph) => paragraph.id));
  let index = 1;
  while (ids.has(`${prefix}${String(index).padStart(4, "0")}`)) index += 1;
  return `${prefix}${String(index).padStart(4, "0")}`;
}

function normalizeParagraphs(paragraphs: ReadonlyArray<Paragraph>): Paragraph[] {
  return paragraphs.map((paragraph, index) => ({
    id: paragraph.id || `p${String(index + 1).padStart(4, "0")}`,
    text: paragraph.text,
  }));
}

export class ParagraphDocument {
  readonly paragraphs: readonly Paragraph[];

  constructor(paragraphs: ReadonlyArray<Paragraph>) {
    this.paragraphs = Object.freeze(normalizeParagraphs(paragraphs));
  }

  static fromParagraphs(paragraphs: ReadonlyArray<Paragraph>): ParagraphDocument {
    return new ParagraphDocument(paragraphs);
  }

  static fromText(text: string, ids: ReadonlyArray<string> = []): ParagraphDocument {
    const parts = text.split(PARAGRAPH_SEPARATOR);
    return new ParagraphDocument(parts.map((part, index) => ({
      id: ids[index] ?? `p${String(index + 1).padStart(4, "0")}`,
      text: part,
    })));
  }

  get text(): string {
    return this.paragraphs.map((paragraph) => paragraph.text).join(PARAGRAPH_SEPARATOR);
  }

  get length(): number {
    return this.text.length;
  }

  ranges(): ParagraphRange[] {
    let cursor = 0;
    return this.paragraphs.map((paragraph, index) => {
      const start = cursor;
      const end = start + paragraph.text.length;
      const separatorStart = end;
      const separatorEnd = index < this.paragraphs.length - 1 ? end + PARAGRAPH_SEPARATOR.length : end;
      cursor = separatorEnd;
      return { ...paragraph, index, start, end, separatorStart, separatorEnd };
    });
  }

  paragraphAt(position: number): ParagraphRange {
    const bounded = Math.max(0, Math.min(position, this.length));
    const ranges = this.ranges();
    for (const range of ranges) {
      if (bounded <= range.end) return range;
      if (bounded < range.separatorEnd) return range;
    }
    return ranges[ranges.length - 1] ?? {
      id: "p0001",
      text: "",
      index: 0,
      start: 0,
      end: 0,
      separatorStart: 0,
      separatorEnd: 0,
    };
  }

  paragraphById(id: string): ParagraphRange | undefined {
    return this.ranges().find((range) => range.id === id);
  }

  split(index: number, offset: number, newParagraphId = generatedId(this.paragraphs)): ParagraphDocument {
    const paragraph = this.paragraphs[index];
    if (!paragraph) return this;
    const safeOffset = Math.max(0, Math.min(offset, paragraph.text.length));
    const next = [...this.paragraphs];
    next.splice(index, 1, {
      id: paragraph.id,
      text: paragraph.text.slice(0, safeOffset),
    }, {
      id: newParagraphId,
      text: paragraph.text.slice(safeOffset),
    });
    return new ParagraphDocument(next);
  }

  merge(index: number): ParagraphDocument {
    if (index <= 0 || index >= this.paragraphs.length) return this;
    const previous = this.paragraphs[index - 1]!;
    const current = this.paragraphs[index]!;
    const next = [...this.paragraphs];
    next.splice(index - 1, 2, {
      id: previous.id,
      text: previous.text + current.text,
    });
    return new ParagraphDocument(next);
  }

  move(index: number, delta: -1 | 1): ParagraphDocument {
    const targetIndex = index + delta;
    if (index < 0 || index >= this.paragraphs.length || targetIndex < 0 || targetIndex >= this.paragraphs.length) return this;
    const next = [...this.paragraphs];
    const [paragraph] = next.splice(index, 1);
    next.splice(targetIndex, 0, paragraph!);
    return new ParagraphDocument(next);
  }

  reconcile(text: string, operation?: ParagraphOperation): ParagraphDocument {
    const parts = text.split(PARAGRAPH_SEPARATOR);
    let ids = this.paragraphs.map((paragraph) => paragraph.id);

    if (operation?.kind === "split") {
      const index = ids.indexOf(operation.paragraphId);
      if (index >= 0) ids.splice(index + 1, 0, operation.newParagraphId);
    } else if (operation?.kind === "merge") {
      const index = ids.indexOf(operation.mergedParagraphId);
      if (index > 0) ids.splice(index, 1);
    } else if (operation?.kind === "move") {
      const index = ids.indexOf(operation.paragraphId);
      if (index >= 0) {
        const [id] = ids.splice(index, 1);
        ids.splice(Math.max(0, Math.min(operation.toIndex, ids.length)), 0, id!);
      }
    }

    while (ids.length < parts.length) ids.push(generatedId(ids.map((id) => ({ id, text: "" }))));
    ids = ids.slice(0, parts.length);
    return new ParagraphDocument(parts.map((part, index) => ({ id: ids[index]!, text: part })));
  }

  toJSON(): Paragraph[] {
    return this.paragraphs.map((paragraph) => ({ ...paragraph }));
  }
}
