import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Workspace } from "./workspace.ts";
import { chapterPaths, readChapterCatalog } from "./chapter-fs.ts";
import { atomicWriteFile } from "@lightee/core/atomic-fs";

export interface WorkspaceIntegrityIssue {
  code: string;
  path: string;
  message: string;
}

export interface WorkspaceIntegrityReport {
  valid: boolean;
  errors: WorkspaceIntegrityIssue[];
  warnings: WorkspaceIntegrityIssue[];
}

const MANAGED_DIRS = ["source", "translations", "state", "terminology", "reviews", "output", "resources"];

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function issue(code: string, path: string, message: string): WorkspaceIntegrityIssue {
  return { code, path, message };
}

async function rejectSymlink(root: string, path: string, errors: WorkspaceIntegrityIssue[]): Promise<void> {
  if (!await exists(path)) return;
  const value = await lstat(path);
  if (value.isSymbolicLink()) errors.push(issue("symlink", relative(root, path), "托管路径不允许使用符号链接"));
}

async function filesIn(path: string): Promise<string[]> {
  if (!await exists(path)) return [];
  return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
}

export async function migrateLegacyEmptyManifest(ws: Workspace, book: string): Promise<boolean> {
  const manifestPath = join(ws.root, "source", "manifest.json");
  if (await exists(manifestPath)) return false;
  const sourceRoot = join(ws.root, "source");
  if (await exists(sourceRoot)) {
    for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if ((await filesIn(join(sourceRoot, entry.name))).some((file) => file.endsWith(".md"))) {
        throw new Error("source/manifest.json 缺失且工作区已有原文；无法安全推断章节归属");
      }
    }
  }
  await atomicWriteFile(manifestPath, `${JSON.stringify({ book, chapters: [] }, null, 2)}\n`);
  return true;
}

export async function inspectWorkspaceIntegrity(ws: Workspace): Promise<WorkspaceIntegrityReport> {
  const errors: WorkspaceIntegrityIssue[] = [];
  const warnings: WorkspaceIntegrityIssue[] = [];
  for (const dir of MANAGED_DIRS) await rejectSymlink(ws.root, join(ws.root, dir), errors);

  let catalog;
  try {
    catalog = await readChapterCatalog(ws);
  } catch (error) {
    errors.push(issue("manifest-invalid", join("source", "manifest.json"), error instanceof Error ? error.message : "manifest 无效"));
    return { valid: false, errors, warnings };
  }

  const chapterIds = new Set(catalog.entries.map((entry) => entry.id));
  for (const entry of catalog.entries) {
    const paths = chapterPaths(ws, entry);
    await rejectSymlink(ws.root, paths.source, errors);
    if (!await exists(paths.source)) {
      errors.push(issue("source-missing", relative(ws.root, paths.source), `manifest 章节 ${entry.id} 缺少原文文件`));
    } else {
      const sourceStat = await lstat(paths.source);
      if (!sourceStat.isFile()) errors.push(issue("source-not-file", relative(ws.root, paths.source), "章节原文不是普通文件"));
    }
    for (const path of [paths.translation, paths.draft, paths.checkpoint, paths.correction, paths.paragraphs]) {
      await rejectSymlink(ws.root, path, errors);
    }
  }

  const sourceRoot = join(ws.root, "source");
  if (await exists(sourceRoot)) {
    for (const volume of await readdir(sourceRoot, { withFileTypes: true })) {
      if (!volume.isDirectory()) continue;
      const volumePath = join(sourceRoot, volume.name);
      await rejectSymlink(ws.root, volumePath, errors);
      for (const file of await filesIn(volumePath)) {
        if (!file.endsWith(".md")) continue;
        const id = file.slice(0, -3);
        if (!chapterIds.has(id)) warnings.push(issue("orphan-source", relative(ws.root, join(volumePath, file)), "原文文件未登记在 manifest"));
      }
    }
  }

  const orphanPatterns: Array<[string, RegExp, string]> = [
    ["translations", /^(ch\d{3,})_zh\.md$/, "orphan-translation"],
    [join("state", "drafts"), /^(ch\d{3,})\.json$/, "orphan-draft"],
    [join("state", "checkpoints"), /^(ch\d{3,})\.json$/, "orphan-checkpoint"],
    [join("state", "source-corrections"), /^(ch\d{3,})\.json$/, "orphan-correction"],
    [join("state", "paragraphs"), /^(ch\d{3,})\.json$/, "orphan-paragraphs"],
  ];
  for (const [dir, pattern, code] of orphanPatterns) {
    for (const file of await filesIn(join(ws.root, dir))) {
      if (file.startsWith(".tmp-")) warnings.push(issue("temporary-file", join(dir, file), "发现未清理的原子写临时文件"));
      const id = pattern.exec(file)?.[1];
      if (id && !chapterIds.has(id)) warnings.push(issue(code, join(dir, file), "章节派生文件没有对应 manifest 章节"));
    }
  }

  const trashRoot = join(ws.root, "state", "trash");
  const indexPath = join(trashRoot, "trash-index.json");
  let indexed = new Set<string>();
  if (await exists(indexPath)) {
    try {
      const parsed = JSON.parse(await readFile(indexPath, "utf8")) as { entries?: Array<{ trashId?: unknown }> };
      if (!Array.isArray(parsed.entries)) throw new Error("entries must be an array");
      indexed = new Set(parsed.entries.map((entry) => typeof entry.trashId === "string" ? entry.trashId : "").filter(Boolean));
      if (indexed.size !== parsed.entries.length) errors.push(issue("trash-index-invalid", relative(ws.root, indexPath), "trash index 包含无效或重复 ID"));
    } catch (error) {
      errors.push(issue("trash-index-invalid", relative(ws.root, indexPath), error instanceof Error ? error.message : "trash index 无效"));
    }
  }
  if (await exists(trashRoot)) {
    for (const entry of await readdir(trashRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(trashRoot, entry.name);
      await rejectSymlink(ws.root, dir, errors);
      if (!indexed.has(entry.name)) warnings.push(issue("orphan-trash", relative(ws.root, dir), "trash 目录未登记在 index"));
      if (!await exists(join(dir, "meta.json"))) errors.push(issue("trash-meta-missing", relative(ws.root, dir), "trash 目录缺少 meta.json"));
    }
  }
  for (const trashId of indexed) {
    const dir = join(trashRoot, trashId);
    if (!await exists(dir)) errors.push(issue("trash-payload-missing", relative(ws.root, dir), "trash index 指向不存在的目录"));
  }

  const rootPrefix = `${ws.root}${sep}`;
  for (const finding of [...errors, ...warnings]) {
    const absolute = join(ws.root, finding.path);
    if (absolute !== ws.root && !absolute.startsWith(rootPrefix)) errors.push(issue("path-escape", finding.path, "完整性检查发现越界路径"));
  }
  return { valid: errors.length === 0, errors, warnings };
}
