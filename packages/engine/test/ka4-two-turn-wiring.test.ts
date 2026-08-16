/**
 * KA-4 接线回归：两轮循环在**真实装配点**上跑通。
 *
 * `validateRegisteredTerms` 的单测只证明「判得对」，证明不了调用点接上了它——
 * TR-05 的同一条教训（那份测试的注释原话：「只证明捞得出来，证明不了调用点用上了它」）。
 *
 * 这里钉的是行为：
 *  - 第一轮拿到工具调用 → 第二轮的消息里必须带 continuation 与 toolResult
 *  - toolResult 的内容里必须**点名**被拒的词（否则整个改动没有意义）
 *  - 模型不调工具时**不发第二轮**（不多花钱）
 */
import { describe, expect, test, beforeEach } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { translateChapterToFile } from "../src/translate-one.ts";
import type { Workspace } from "../src/workspace.ts";
import type { PipelineConfig } from "../src/cli-pipeline.ts";

let root: string;
let ws: Workspace;
let config: PipelineConfig;

/** 原文为测试专门编写，不取自任何作品。含一个专名供登记。 */
const SOURCE = [
  "セラフィナは窓の外を見つめた。",
  "「早馬が来ました」と兵が告げる。",
  "少女は静かに頷いた。",
].join("\n\n");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ka4-"));
  ws = { root } as Workspace;
  for (const dir of ["source/v01", "terminology", "translations", "state"]) {
    await mkdir(join(root, dir), { recursive: true });
  }
  await writeFile(
    join(root, "source", "manifest.json"),
    JSON.stringify({ book: "测试书", chapters: [{ id: "ch001", title: "第一章", volume: "v01" }] }),
    "utf-8"
  );
  await writeFile(join(root, "source", "v01", "ch001.md"), SOURCE, "utf-8");
  config = {
    project: { name: "测试", srcLang: "ja", tgtLang: "zh" },
    agents: { translator: { model: "deepseek/deepseek-v4-pro", thinking: "high" } },
    translation: { mode: "quality", concurrency: 1, batchChars: 4000, contextWindow: 131072 },
  };
});

/**
 * 只读 **user** 那条消息里的段落 id：system 前缀里有教学样例（p0001/p0002），
 * 把它一并抓进来会造出一个真实模型不会犯的错，然后拿它去指责生产代码。
 */
function paragraphsFor(messages: Array<{ role: string; content: string }>): string {
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  const ids = [...user.matchAll(/<paragraph id="([^"]+)"/g)].map((m) => m[1]!);
  return [...new Set(ids)].map((id) => `<paragraph id="${id}">译文${id}</paragraph>`).join("\n");
}

interface Turn {
  roles: string[];
  hasTools: boolean;
  continuation: unknown;
  toolResultText?: string;
}

/**
 * 第一轮只发工具调用（工具协议的正常一轮），第二轮给正文。
 * `terms` 里故意混一个原文中不存在的词——补救层必须拦下并把它说回去。
 */
function twoTurnLlm(log: Turn[]) {
  let call = 0;
  const CONTINUATION = { role: "assistant", content: [{ type: "thinking", thinking: "…", thinkingSignature: "SIG" }], marker: "turn1" };
  return {
    complete: async (
      _model: string,
      messages: Array<{ role: string; content: string; continuation?: unknown }>,
      opts?: { tools?: unknown[] }
    ) => {
      call += 1;
      log.push({
        roles: messages.map((m) => m.role),
        hasTools: (opts?.tools?.length ?? 0) > 0,
        continuation: messages.find((m) => m.continuation)?.continuation,
        ...(messages.find((m) => m.role === "toolResult") ? { toolResultText: messages.find((m) => m.role === "toolResult")!.content } : {}),
      });
      if (call === 1) {
        return {
          text: "",
          continuation: CONTINUATION,
          stopReason: "toolUse",
          toolCalls: [{
            id: "call_1",
            name: "register_terms",
            arguments: {
              terms: [
                { ja: "セラフィナ", zh: "塞拉菲娜", type: "person", note: null },
                { ja: "竜王アルゲンタム", zh: "龙王阿尔根图姆", type: "person", note: "本章没有这个词" },
              ],
              voices: [{ character: "セラフィナ", selfRef: "わたくし", register: "敬体", gender: "女", quirk: null, zhStrategy: "端庄", evidence: "少女は静かに頷いた。" }],
            },
          }],
        };
      }
      return { text: paragraphsFor(messages), stopReason: "stop" };
    },
  };
}

/** 一轮就给正文（本章没有新词）——不该再发第二轮 */
function singleTurnLlm(log: Turn[]) {
  return {
    complete: async (_model: string, messages: Array<{ role: string; content: string }>, opts?: { tools?: unknown[] }) => {
      log.push({ roles: messages.map((m) => m.role), hasTools: (opts?.tools?.length ?? 0) > 0, continuation: undefined });
      return { text: paragraphsFor(messages), stopReason: "stop" };
    },
  };
}

describe("两轮循环", () => {
  test("第二轮带着 continuation 与 toolResult，且 continuation 是第一轮的原对象", async () => {
    const log: Turn[] = [];
    const llm = twoTurnLlm(log);
    await translateChapterToFile(ws, "ch001", llm as never, config);

    expect(log).toHaveLength(2);
    expect(log[0]?.roles).toEqual(["system", "user"]);
    expect(log[1]?.roles).toEqual(["system", "user", "assistant", "toolResult"]);
    // 原对象引用直达——中间没有任何一层把它拆开又拼回来（推理签名就在里面）
    expect(log[1]?.continuation).toMatchObject({ marker: "turn1" });
    // 两轮都要带工具：第二轮不带的话，服务商看到历史里有工具调用却无工具定义会拒
    expect(log.every((t) => t.hasTools)).toBe(true);
  });

  test("toolResult 点名被拒的词——这是整个改动的意义所在", async () => {
    const log: Turn[] = [];
    await translateChapterToFile(ws, "ch001", twoTurnLlm(log) as never, config);
    const text = log[1]?.toolResultText ?? "";
    expect(text).toContain("竜王アルゲンタム");
    expect(text).toContain("不在本章原文中");
    // 采纳的译法也要说，否则模型不知道该沿用哪个
    expect(text).toContain("セラフィナ→塞拉菲娜");
  });

  test("补救层过滤后的词与语气卡进结果，幻觉不进", async () => {
    const result = await translateChapterToFile(ws, "ch001", twoTurnLlm([]) as never, config);
    expect(result.newTerms.map((t) => t.ja)).toEqual(["セラフィナ"]);
    expect(result.newVoices).toHaveLength(1);
    expect(result.newVoices[0]?.selfRef).toBe("わたくし");
  });

  test("模型不调工具时只发一轮——本章没有新词不是多花一次钱的理由", async () => {
    const log: Turn[] = [];
    const result = await translateChapterToFile(ws, "ch001", singleTurnLlm(log) as never, config);
    expect(log).toHaveLength(1);
    expect(result.newTerms).toHaveLength(0);
  });
});
