/**
 * register-archive —— 登记即注入（ADR-0008 / TP-2）。
 *
 * 融合提取登记的词从这里直写术语档案（provenance=model），下一章开工重读快照时
 * 立即进入注入块。12 章实测（evidence-1786585063380）证明旧路径（登记→卡片→等确认→
 * 才进档案）的结局：87 卡全悬置、档案 0 条、注入块全程「（无）」、59% 登记是重复推导。
 *
 * ## 边界（谁不进档案）
 *
 * - **pun**：双关的处理策略（直译+注／中文梗替代／保留原文）是作者裁量——0003 的这条
 *   理由于双关仍然成立，双关继续走卡片闸门；
 * - **无译法的词**：注入块没法注一个空译法（【待审:】标记与假名残留反推只知道原文形态）；
 * - **voices**：语气影响全书文风且无机械回滚手段（ADR-0008 明文排除）。
 *
 * ## 并发与幂等
 *
 * 写用 action="prepared"：已存在的词条**旧值赢**——跨章一致性靠先到先得，
 * 后续章节对同一词的再登记（正常情况下被 toolKnown 拦住，竞态漏网时）不改先例。
 * operationId 取章号+词表的内容哈希：门禁重试重放同一批词时仓库直接回放旧提交，
 * 不产生重复行。
 */
import { createHash } from "node:crypto";
import { TerminologyRepository, type TerminologyArchive, type TerminologyMergeEntry } from "@lightee/core/terminology-repository";
import { withProvenance } from "@lightee/core/term-provenance";
import type { FusedTerm } from "@lightee/core/extract-fuse";

/** 纯映射：登记词 → 档案合并条目。person → names，其余 → terms；pun 与无译法的词不进。 */
export function provisionalEntriesFor(terms: ReadonlyArray<FusedTerm>): TerminologyMergeEntry[] {
  return terms
    .filter((term) => term.type !== "pun" && typeof term.zh === "string" && term.zh.length > 0)
    .map((term) => ({
      archive: (term.type === "person" ? "names" : "terms") as TerminologyArchive,
      entry: withProvenance(
        {
          ja: term.ja,
          zh: term.zh,
          type: term.type,
          ...(term.note ? { note: term.note } : {}),
        },
        "model",
      ),
    }));
}

/**
 * 晋升前置包含检查（TP-3）。新词与在档译名互为包含时，日后改任何一方的译法，
 * 重叠位都要走占位判定、咬合处进人工复核——这件事在**入档时**就说得清，
 * 不该等到几十章之后改名时才被发现。只提醒，不拦：包含关系本身不是错误
 * （「圣女」与「星之圣女」并存完全正当）。
 */
export function containmentNotes(
  entries: ReadonlyArray<TerminologyMergeEntry>,
  existingZh: ReadonlyArray<string>,
): string[] {
  const notes: string[] = [];
  const seen: string[] = [...existingZh.filter((zh) => typeof zh === "string" && zh.length > 0)];
  for (const { entry } of entries) {
    const zh = typeof entry.zh === "string" ? entry.zh : "";
    if (!zh) continue;
    const container = seen.find((other) => other !== zh && other.includes(zh));
    const contained = seen.find((other) => other !== zh && zh.includes(other));
    if (container) notes.push(`「${zh}」是在档译名「${container}」的子串——改译任一方时，重叠处会按占位判定处理`);
    else if (contained) notes.push(`「${zh}」包含在档译名「${contained}」——改译任一方时，重叠处会按占位判定处理`);
    seen.push(zh); // 同批新词之间的包含关系同样要报
  }
  return notes;
}

/** 落档。零条目时不发操作——空合并连 operationId 都不该占。 */
export async function archiveRegisteredTerms(
  root: string,
  chapterId: string,
  terms: ReadonlyArray<FusedTerm>,
): Promise<{ archived: number; notes: string[] }> {
  const entries = provisionalEntriesFor(terms);
  if (entries.length === 0) return { archived: 0, notes: [] };
  const repository = new TerminologyRepository(root);
  // 前置检查读的是合并前的快照——合并后自己也在档里，人人都是自己的子串
  const snapshot = await repository.readSnapshot();
  const existingZh = [...snapshot.archives.names, ...snapshot.archives.terms]
    .map((item) => (typeof item.zh === "string" ? item.zh : ""))
    .filter(Boolean);
  const notes = containmentNotes(entries, existingZh);
  const digest = createHash("sha256")
    .update(JSON.stringify({ chapterId, entries: entries.map((item) => [item.archive, item.entry.ja, item.entry.zh]) }))
    .digest("hex")
    .slice(0, 16);
  await repository.mergeEntries({
    operationId: `register:${chapterId}:${digest}`,
    action: "prepared",
    entries,
  });
  return { archived: entries.length, notes };
}
