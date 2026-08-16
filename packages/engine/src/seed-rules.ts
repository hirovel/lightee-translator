/**
 * seed-rules —— 新建工作区时播种的内置作者规则。
 *
 * **当前为空（作者裁定 2026-08-13）。**
 *
 * 这里曾播种两条对话标点正则（句末补句号 / 「吗」结尾补问号）。撤销的理由是它们的
 * 出处：那是从**一本书**的实测语料里总结出来的写作偏好，不是中文排印的通则。
 * 把一本书的结论当默认值塞进每一个工作区，等于替所有作者做了一个他们没做过的选择——
 * 而且这个选择会**直接改写译文**。默认值可以有，但必须是普遍成立的东西。
 *
 * 需要这类规则的作者仍可在术语表的「译后字典」里自己加，能力一点没少；
 * 少掉的只是「未经同意就先替你加上」这件事。
 *
 * 播种机制本身保留（这个函数与它的唯一调用点），日后若真有普遍成立的默认规则，
 * 往 `SEEDED_POST_DICT_RULES` 里加即可，不必重建一条路径。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "@lightee/core/atomic-fs";

import type { DictRule } from "./dictionary.ts";

/**
 * 播种到译后字典档案的全部规则。**顺序即应用顺序**（见 applyDictionary）。
 *
 * 空表 = 新工作区的译后字典从零开始。
 */
export const SEEDED_POST_DICT_RULES: ReadonlyArray<DictRule & { id: string; status: string }> = [];

/** 译后字典的档案投影文件名（与 TerminologyRepository 的 PROJECTION_FILES.postDict 一致）。 */
const PROJECTION_POST_DICT = "post-dict.json";

/**
 * 向工作区播种内置译后规则。唯一调用点是 `createWorkspaceSkeleton`。
 *
 * 历史：创建工作区曾有两条各写各的路径（engine 的 `createWorkspace` 与 Electron 的
 * `workspace.create`），播种首版只做了前者，端到端跑真实模型时 post-dict.json 是空的，
 * 规则一条没生效。IV-02 已把骨架合成一份，这里不必再考虑「另一条路径漏了没」。
 *
 * 时机要求：必须在术语仓库首次读档案**之前**调用。仓库无快照时会接管投影文件建立初始
 * 快照（readLegacyArchivesUnlocked），晚了就只会看到自己写下的空表。
 *
 * 只在文件不存在时写：作者停用或删掉规则后重开工作区，不该被“修好”。
 */
export async function seedPostDictRules(root: string): Promise<void> {
  const path = join(root, "terminology", PROJECTION_POST_DICT);
  if (existsSync(path)) return;
  await atomicWriteFile(path, `${JSON.stringify(SEEDED_POST_DICT_RULES, null, 2)}\n`);
}
