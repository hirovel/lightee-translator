import { describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createIpcService } from "./ipc-service.js";

function envelope(command: string, payload: unknown) {
  return { version: 1, requestId: `${command}-test`, command, payload };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "lightee-registry-"));
  const workspaceRoot = join(root, "book");
  const registryPath = join(root, "user", "workspaces.json");
  await mkdir(join(workspaceRoot, "source", "v01"), { recursive: true });
  await mkdir(join(workspaceRoot, "state"), { recursive: true });
  await writeFile(join(workspaceRoot, "book.yaml"), "name: 测试书\nsrcLang: ja\ntgtLang: zh\nvolumes:\n  - id: v01\n    label: 第一卷\n", "utf8");
  await writeFile(join(workspaceRoot, "source", "manifest.json"), JSON.stringify({
    book: "测试书",
    sourceFormat: "txt",
    chapters: [{ id: "ch001", title: "第一章", volume: "v01", charCount: 4 }],
  }), "utf8");
  await writeFile(join(workspaceRoot, "source", "v01", "ch001.md"), "# 第一章\n\n原文\n", "utf8");
  return { root, workspaceRoot, registryPath };
}

describe("IpcService workspace registry", () => {
  it("persists registry, real tree, session and canonical renames across service instances", async () => {
    const fixture = await createFixture();
    try {
      const first = createIpcService({ registryPath: fixture.registryPath });
      const opened = await first.invoke(envelope("workspace.open", { path: fixture.workspaceRoot }));
      expect(opened).toMatchObject({ ok: true, value: { name: "测试书", status: "ready", volumes: [{ id: "v01", label: "第一卷", chapters: [{ id: "ch001", title: "第一章" }] }] } });
      if (!opened.ok) return;

      const workspaceId = opened.value.id;
      expect(await first.invoke(envelope("workspace.session.write", { workspaceId, chapterId: "ch001" }))).toMatchObject({ ok: true, value: { workspaceId, chapterId: "ch001" } });
      expect(await first.invoke(envelope("workspace.renameVolume", { workspaceId, volumeId: "v01", name: "序章卷" }))).toMatchObject({ ok: true, value: { volumes: [{ label: "序章卷" }] } });
      expect(await first.invoke(envelope("workspace.renameChapter", { workspaceId, volumeId: "v01", chapterId: "ch001", title: "改名后的第一章" }))).toMatchObject({ ok: true, value: { volumes: [{ chapters: [{ title: "改名后的第一章" }] }] } });

      const second = createIpcService({ registryPath: fixture.registryPath });
      const listed = await second.invoke(envelope("workspace.list", {}));
      expect(listed).toMatchObject({ ok: true, value: [{ id: workspaceId, status: "ready", volumes: [{ label: "序章卷", chapters: [{ title: "改名后的第一章" }] }] }] });
      const session = await second.invoke(envelope("workspace.session.read", {}));
      expect(session).toMatchObject({ ok: true, value: { workspaceId, chapterId: "ch001" } });
      expect(await readFile(join(fixture.workspaceRoot, "book.yaml"), "utf8")).toContain("label: 序章卷");
      expect(await readFile(join(fixture.workspaceRoot, "source", "manifest.json"), "utf8")).toContain("改名后的第一章");
      expect(await readFile(join(fixture.workspaceRoot, "source", "v01", "ch001.md"), "utf8")).toContain("# 改名后的第一章");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps stale registry entries visible and rejects opening missing directories", async () => {
    const fixture = await createFixture();
    try {
      const first = createIpcService({ registryPath: fixture.registryPath });
      const created = await first.invoke(envelope("workspace.create", { path: fixture.workspaceRoot, name: "测试书" }));
      expect(created.ok).toBe(true);
      await rm(fixture.workspaceRoot, { recursive: true, force: true });

      const second = createIpcService({ registryPath: fixture.registryPath });
      const listed = await second.invoke(envelope("workspace.list", {}));
      expect(listed).toMatchObject({ ok: true, value: [{ status: "missing", volumes: [] }] });
      const opened = await second.invoke(envelope("workspace.open", { path: fixture.workspaceRoot }));
      expect(opened).toMatchObject({ ok: false, error: { code: "not_found" } });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
