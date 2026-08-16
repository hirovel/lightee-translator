/**
 * 工作区初始化 + 卷管理（见 docs/lightee-wiki.md：卷→章两级）。
 */

import { mkdir, readFile, readdir } from "node:fs/promises";
import { atomicWriteFile } from "@lightee/core/atomic-fs";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { seedPostDictRules } from "./seed-rules.ts";

export interface Workspace {
  root: string;
}

export interface VolumeInfo {
  id: string;
  label: string;
}

/**
 * 当前支持的工作区 schema 版本。
 *
 * 定义在这里而不是 Electron 侧：schema 版本是**工作区的属性**，不属于某个前端。
 * Electron 的 `CURRENT_SCHEMA_VERSION` 转出本常量，迁移注册表仍留在 Electron。
 */
export const WORKSPACE_SCHEMA_VERSION = 1;

/**
 * 新建工作区时创建的目录骨架。顺序无关，但缺一个都会让后续写入路径 ENOENT。
 *
 * 这份清单是工作区的**定义**，所以住在 engine——此前它有两份（engine 内联在
 * `createWorkspace` 里、Electron 在 `workspace-scan.ts` 里叫 `WORKSPACE_DIRS`），
 * 两份已经漂移：engine 建 `state/orders` 不建 checkpoints/corrections/trash，
 * Electron 反过来。谁也没发现，因为写入侧全都 `mkdir recursive` 兜住了。
 *
 * 不含 `state/staging`：那是翻译中途的暂存稿目录，由 paragraph-gate 按需创建，
 * 空工作区里凭空立一个它会让「有没有暂存稿」这件事读不出来。
 */
export const WORKSPACE_DIRS = [
  "source",
  "terminology",
  "translations",
  "reviews",
  "state/checkpoints",
  "state/source-corrections",
  "state/trash",
  "sessions",
  "output",
  "resources",
  ".agents",
];

/**
 * 工作区骨架：目录 + book.yaml + manifest + 内置规则播种（全部幂等）。
 *
 * **创建工作区的唯一实现**。engine 的 `createWorkspace`（CLI/测试）与 Electron 的
 * `workspace.create`（真实用户路径）都从这里出发，各自只加自己独有的副作用——
 * Electron 还要写注册表、发事件、起术语监听器，CLI 不需要。
 *
 * 边界：本函数**只碰工作区目录内部**，一行都不许碰注册表、事件、UI 状态。
 * 上一次两条路径分头实现的代价是译后规则只在 CLI 一侧生效，单元测试全绿而真实
 * 用户一条规则没拿到。
 */
export async function createWorkspaceSkeleton(
  root: string,
  meta: { name: string; srcLang?: string; tgtLang?: string }
): Promise<void> {
  for (const directory of WORKSPACE_DIRS) {
    await mkdir(join(root, directory), { recursive: true });
  }
  // 内置译后规则必须在术语仓库首次读档案**之前**播种：仓库无快照时会接管投影文件建立
  // 初始快照，晚一步就只会看到自己写下的空表。
  await seedPostDictRules(root);
  const bookPath = join(root, "book.yaml");
  // 判据是「有没有书名」而不是「文件在不在」：没有 name 的 book.yaml 打不开工作区
  // （workspaceInfo 直接拒），此时把它当成不存在补齐，比留着一个开不了的半成品好。
  // 既有的 name 一个字都不改——那是用户的书名。
  const existingBook = existsSync(bookPath) ? await readFile(bookPath, "utf-8") : "";
  if (!/^name:\s*\S/m.test(existingBook)) {
    const carried = existingBook.split("\n").filter((line) => line.trim() && !/^(name|srcLang|tgtLang|status|schemaVersion):/.test(line));
    await atomicWriteFile(
      bookPath,
      `name: ${meta.name}\nsrcLang: ${meta.srcLang ?? "ja"}\ntgtLang: ${meta.tgtLang ?? "zh"}\nstatus: imported\nschemaVersion: ${WORKSPACE_SCHEMA_VERSION}\n${carried.length ? `${carried.join("\n")}\n` : ""}`
    );
  }
  const manifestPath = join(root, "source", "manifest.json");
  if (!existsSync(manifestPath)) {
    await atomicWriteFile(manifestPath, `${JSON.stringify({ book: meta.name, chapters: [] }, null, 2)}\n`);
  }
}

/** 创建工作区目录结构（幂等）。CLI 与测试用；真实用户走 Electron 的 workspace.create */
export async function createWorkspace(
  root: string,
  meta: { name: string; srcLang?: string; tgtLang?: string }
): Promise<Workspace> {
  await createWorkspaceSkeleton(root, meta);
  return { root: resolve(root) };
}

// ===== 卷管理 =====

const BOOK_YAML_RE = /^volumes:\s*$/m;

/** 读取全部卷（book.yaml volumes 段） */
export async function listVolumes(ws: Workspace): Promise<VolumeInfo[]> {
  const path = join(ws.root, "book.yaml");
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf-8");
  const vols: VolumeInfo[] = [];
  let inVolumes = false;
  let cur: VolumeInfo | null = null;
  for (const line of raw.split("\n")) {
    if (/^volumes:\s*$/.test(line)) {
      inVolumes = true;
      continue;
    }
    if (!inVolumes) continue;
    const idM = /^\s*-\s*id:\s*(\S+)\s*$/.exec(line);
    if (idM) {
      if (cur) vols.push(cur);
      cur = { id: idM[1]!, label: idM[1]! };
      continue;
    }
    const labelM = /^\s*label:\s*(.+)$/.exec(line);
    if (labelM && cur) {
      cur.label = labelM[1]!.trim();
      continue;
    }
    // 非缩进列表项 → 离开 volumes 段
    if (line.trim() && !/^\s*-/.test(line)) inVolumes = false;
  }
  if (cur) vols.push(cur);
  return vols;
}

/** 下一卷 id（v01 → v02 …，按已有卷数+1） */
export async function nextVolumeId(ws: Workspace): Promise<string> {
  const vols = await listVolumes(ws);
  const max = vols.reduce((acc, v) => {
    const m = /^v(\d+)$/.exec(v.id);
    return m ? Math.max(acc, parseInt(m[1]!, 10)) : acc;
  }, 0);
  return `v${String(max + 1).padStart(2, "0")}`;
}

/** 卷中文标签（v01 → 第一卷） */
export function volumeLabel(id: string): string {
  const m = /^v(\d+)$/.exec(id);
  if (!m) return id;
  const CN = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  const n = parseInt(m[1]!, 10);
  if (n <= 10) return `第${CN[n]}卷`;
  if (n < 100) return `第${Math.floor(n / 10)}十${n % 10 === 0 ? "" : CN[n % 10]}卷`;
  return `第${n}卷`;
}

/** 确保卷目录存在（source/translations/resources 子目录） */
export async function ensureVolumeDirs(ws: Workspace, volumeId: string): Promise<void> {
  for (const d of ["source", "translations", "resources"]) {
    await mkdir(join(ws.root, d, volumeId), { recursive: true });
  }
}

/** 登记卷到 book.yaml。ID 幂等；at 只影响首次插入位置。 */
export async function addVolume(ws: Workspace, id: string, label: string, options: { at?: number } = {}): Promise<void> {
  const path = join(ws.root, "book.yaml");
  const raw = existsSync(path) ? await readFile(path, "utf-8") : `name: 未命名\nstatus: imported\n`;
  if ((await listVolumes(ws)).some((volume) => volume.id === id)) {
    await ensureVolumeDirs(ws, id);
    return;
  }
  const itemLines = [`  - id: ${id}`, `    label: ${label}`];
  if (!/^volumes:\s*$/m.test(raw)) {
    await atomicWriteFile(path, `${raw.replace(/\n*$/, "\n")}volumes:\n${itemLines.join("\n")}\n`);
    await ensureVolumeDirs(ws, id);
    return;
  }
  const lines = raw.replace(/\n$/, "").split("\n");
  const volumeHeader = lines.findIndex((line) => /^volumes:\s*$/.test(line));
  const starts: number[] = [];
  let sectionEnd = lines.length;
  for (let index = volumeHeader + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() && !/^\s/.test(line)) { sectionEnd = index; break; }
    if (/^\s+-\s+id:/.test(line)) starts.push(index);
  }
  const at = Math.min(Math.max(0, options.at ?? starts.length), starts.length);
  const insertAt = starts[at] ?? sectionEnd;
  lines.splice(insertAt, 0, ...itemLines);
  await atomicWriteFile(path, `${lines.join("\n")}\n`);
  await ensureVolumeDirs(ws, id);
}

/** 卷内已有章节数（用于编号顺延） */
export async function countChaptersInVolume(ws: Workspace, volumeId: string): Promise<number> {
  const dir = join(ws.root, "source", volumeId);
  if (!existsSync(dir)) return 0;
  const files = await readdir(dir);
  return files.filter((f) => /^ch\d{3}\.md$/.test(f)).length;
}
