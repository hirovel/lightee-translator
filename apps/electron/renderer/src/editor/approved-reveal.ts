export interface RevealParagraph {
  id: string;
  text: string;
}

export interface ApprovedRevealOptions {
  wait(milliseconds: number): Promise<void>;
  isCancelled(): boolean;
  onDocument(paragraphs: RevealParagraph[]): void;
  onProgress(): void;
}

export async function revealApprovedParagraphs(
  paragraphs: RevealParagraph[],
  options: ApprovedRevealOptions,
): Promise<boolean> {
  const target = paragraphs.map((paragraph) => ({ ...paragraph }));
  const totalCharacters = target.reduce((sum, paragraph) => sum + paragraph.text.length, 0);
  if (totalCharacters === 0) {
    options.onDocument(target);
    options.onProgress();
    return true;
  }

  options.onDocument(target.map((paragraph) => ({ id: paragraph.id, text: "" })));
  let visibleCharacters = 0;
  const step = Math.max(8, Math.ceil(totalCharacters / 48));
  while (visibleCharacters < totalCharacters) {
    await options.wait(18);
    if (options.isCancelled()) return false;
    visibleCharacters = Math.min(totalCharacters, visibleCharacters + step);
    let remaining = visibleCharacters;
    const partial = target.map((paragraph) => {
      const count = Math.min(paragraph.text.length, remaining);
      remaining = Math.max(0, remaining - count);
      return { id: paragraph.id, text: paragraph.text.slice(0, count) };
    });
    options.onDocument(partial);
    options.onProgress();
  }
  return true;
}
