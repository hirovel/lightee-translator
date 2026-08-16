/**
 * pending-voices —— 语气档案的待办暂存（KA-6 止血层）。
 *
 * 语气档案的完整链路本该是：register_terms 工具产出 → 作者确认卡 → voice 档案 →
 * persona 注入后续章节。历史是：EX-07 拆掉了旧的产线（译前提取的 voice-extraction），
 * KA-4 重建产出端时只把**词**接到了下游（登记即注入），voices 校验完返回后没有任何
 * 消费者——模型认真填的档案静默蒸发，连 warn 都没有。
 *
 * ADR-0008 明文排除 voices 走自动入档（语气影响全书文风且无机械回滚手段），
 * 所以这里**不写 voice 档案**。在确认卡通道建成（KA-6 修法 A）之前，本模块只保证两件事：
 * 不丢（落 state/pending-voices.json），出声（调用方据返回值发 warn）。
 * 通道建成后，这个文件就是它的进料口。
 */
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { atomicWriteJson } from "@lightee/core/atomic-fs";
import type { RegisteredVoice } from "./register-terms.ts";
import type { Workspace } from "./workspace.ts";

export interface PendingVoice extends RegisteredVoice {
  /** 在哪一章辨认出来的（确认卡要给作者看出处） */
  chapterId: string;
}

function pendingVoicesPath(ws: Workspace): string {
  return join(ws.root, "state", "pending-voices.json");
}

export async function readPendingVoices(ws: Workspace): Promise<PendingVoice[]> {
  try {
    const parsed = JSON.parse(await readFile(pendingVoicesPath(ws), "utf-8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PendingVoice =>
      !!item && typeof item === "object" && typeof (item as PendingVoice).character === "string"
    );
  } catch {
    return [];
  }
}

/**
 * 合并落盘，按角色名去重、**先到先得**——与 register-archive 对词的取舍同一条理由：
 * 跨章一致性靠先例，后一章对同一角色的再辨认不覆盖先例（真要改，走作者终审面）。
 * 返回本次真正新增的条目，调用方据此决定要不要出声。
 */
export async function recordPendingVoices(
  ws: Workspace,
  voices: ReadonlyArray<RegisteredVoice>,
  chapterId: string,
): Promise<PendingVoice[]> {
  if (voices.length === 0) return [];
  const existing = await readPendingVoices(ws);
  const byCharacter = new Map(existing.map((voice) => [voice.character, voice]));
  const added: PendingVoice[] = [];
  for (const voice of voices) {
    if (!voice.character || byCharacter.has(voice.character)) continue;
    const entry: PendingVoice = { ...voice, chapterId };
    byCharacter.set(voice.character, entry);
    added.push(entry);
  }
  if (added.length === 0) return [];
  await atomicWriteJson(pendingVoicesPath(ws), [...byCharacter.values()]);
  return added;
}
