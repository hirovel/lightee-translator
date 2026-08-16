import { mkdir, readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChapterStateStore } from "@lightee/core/chapter-state";
import { recoverChapterPromotion } from "../src/chapter-pipeline.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lightee-promotion-"));
  roots.push(root);
  await mkdir(join(root, "state", "promotion"), { recursive: true });
  await mkdir(join(root, "state", "staging"), { recursive: true });
  await mkdir(join(root, "translations"), { recursive: true });
  return root;
}

describe("chapter promotion recovery", () => {
  it("restores the previous approved file when state commit did not happen", async () => {
    const root = await makeWorkspace();
    const store = new ChapterStateStore(root);
    await store.transition("ch001", "ready", { runId: "old" });
    await store.transition("ch001", "translating", { runId: "old" });
    await store.transition("ch001", "translated", { runId: "old" });
    await store.transition("ch001", "reviewing", { runId: "old" });
    await writeFile(join(root, "translations", "ch001_zh.md"), "旧 approved", "utf8");
    await writeFile(join(root, "state", "staging", "ch001_zh.md"), "新 staging", "utf8");
    await writeFile(join(root, "state", "promotion", "ch001.bak.md"), "旧 approved", "utf8");
    await writeFile(join(root, "state", "promotion", "ch001.json"), JSON.stringify({ runId: "new", hasPrevious: true }), "utf8");

    await recoverChapterPromotion({ root }, "ch001");

    expect(await readFile(join(root, "translations", "ch001_zh.md"), "utf8")).toBe("旧 approved");
    expect(await readFile(join(root, "state", "staging", "ch001_zh.md"), "utf8")).toBe("新 staging");
    await expect(readFile(join(root, "state", "promotion", "ch001.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("finishes a committed approval and removes the promotion journal", async () => {
    const root = await makeWorkspace();
    const store = new ChapterStateStore(root);
    await store.transition("ch001", "ready", { runId: "run" });
    await store.transition("ch001", "translating", { runId: "run" });
    await store.transition("ch001", "translated", { runId: "run" });
    await store.transition("ch001", "reviewing", { runId: "run" });
    await store.transition("ch001", "approved", { runId: "run" });
    await writeFile(join(root, "translations", "ch001_zh.md"), "旧 approved", "utf8");
    await writeFile(join(root, "state", "staging", "ch001_zh.md"), "新 approved", "utf8");
    await writeFile(join(root, "state", "promotion", "ch001.bak.md"), "旧 approved", "utf8");
    await writeFile(join(root, "state", "promotion", "ch001.json"), JSON.stringify({ runId: "run", hasPrevious: true }), "utf8");

    await recoverChapterPromotion({ root }, "ch001");

    expect(await readFile(join(root, "translations", "ch001_zh.md"), "utf8")).toBe("新 approved");
    await expect(readFile(join(root, "state", "staging", "ch001_zh.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "state", "promotion", "ch001.bak.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
