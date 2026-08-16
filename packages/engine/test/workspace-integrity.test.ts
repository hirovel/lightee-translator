import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectWorkspaceIntegrity } from "../src/workspace-integrity.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "lightee-fsck-"));
  roots.push(root);
  await mkdir(join(root, "source", "v01"), { recursive: true });
  await mkdir(join(root, "translations"), { recursive: true });
  await mkdir(join(root, "state"), { recursive: true });
  await writeFile(join(root, "source", "manifest.json"), JSON.stringify({ book: "Test", chapters: [{ id: "ch001", title: "One", volume: "v01" }] }));
  await writeFile(join(root, "source", "v01", "ch001.md"), "source");
  return { root };
}

describe("inspectWorkspaceIntegrity", () => {
  it("accepts a canonical workspace", async () => {
    const ws = await workspace();
    expect(await inspectWorkspaceIntegrity(ws)).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it("blocks manifest entries without canonical source", async () => {
    const ws = await workspace();
    await rm(join(ws.root, "source", "v01", "ch001.md"));
    const report = await inspectWorkspaceIntegrity(ws);
    expect(report.valid).toBe(false);
    expect(report.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "source-missing" })]));
  });

  it("reports orphan source and derived files without deleting them", async () => {
    const ws = await workspace();
    await writeFile(join(ws.root, "source", "v01", "ch999.md"), "orphan");
    await writeFile(join(ws.root, "translations", "ch999_zh.md"), "orphan");
    const report = await inspectWorkspaceIntegrity(ws);
    expect(report.valid).toBe(true);
    expect(report.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(["orphan-source", "orphan-translation"]));
  });

  it("blocks a trash index whose payload directory is missing", async () => {
    const ws = await workspace();
    await mkdir(join(ws.root, "state", "trash"), { recursive: true });
    await writeFile(join(ws.root, "state", "trash", "trash-index.json"), JSON.stringify({ entries: [{ trashId: "tr-missing" }] }));
    const report = await inspectWorkspaceIntegrity(ws);
    expect(report.valid).toBe(false);
    expect(report.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "trash-payload-missing" })]));
  });
});
