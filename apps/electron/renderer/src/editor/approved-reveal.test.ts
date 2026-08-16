import { describe, expect, it } from "vitest";
import { revealApprovedParagraphs } from "./approved-reveal.js";

describe("approved reveal", () => {
  it("cancels without claiming completion when the editor changes during reveal", async () => {
    let cancelled = false;
    let progress = 0;
    const documents: Array<Array<{ id: string; text: string }>> = [];
    const result = await revealApprovedParagraphs([{ id: "p1", text: "approved text" }], {
      wait: async () => { cancelled = true; },
      isCancelled: () => cancelled,
      onDocument: (paragraphs) => documents.push(paragraphs),
      onProgress: () => { progress += 1; },
    });

    expect(result).toBe(false);
    expect(progress).toBe(0);
    expect(documents.at(-1)?.[0]?.text).toBe("");
  });

  it("reports completion only after the full approved text is visible", async () => {
    const documents: Array<Array<{ id: string; text: string }>> = [];
    const result = await revealApprovedParagraphs([{ id: "p1", text: "approved" }], {
      wait: async () => undefined,
      isCancelled: () => false,
      onDocument: (paragraphs) => documents.push(paragraphs),
      onProgress: () => undefined,
    });

    expect(result).toBe(true);
    expect(documents.at(-1)?.[0]?.text).toBe("approved");
  });
});
