/**
 * TR-12：接收端整改——「未正常结束」的正确退路是切小任务，不是降档重来。
 *
 * ## 审查发现（2026-08-12，第三次跑批之后）
 *
 * 1. **降档梯子还挂在 incomplete 上**：思考吃光输出预算（medium+ 档整章打草稿，
 *    二元开关）时，降档确实能出文本，但那是把用户选的档位偷偷换掉、并把整份预算
 *    再烧一遍——46 章 × 每章几档 = 184 次注定失败的付费调用。
 * 2. **判截断靠数标签**：`TranslateLlm` 的返回类型只有 `text`，于是 `looksTruncated`
 *    只能数 `<paragraph>` 开闭差——而服务商在 `rawStopReason` 里明说了有没有正常结束。
 *    截断恰好落在段落边界、已到段落 ≥80% 时，启发式两条判据都不触发。
 * 3. **废掉的尝试没记 rawStopReason**：废掉的尝试是唯一需要问「为什么废的」的地方。
 * 4. **tokenTotals 只加成功那次**：账本记对了、侧栏低报，两边对不上。
 * 5. **历史回读把 TR-11 字段洗掉**：normalizeUsage 硬编码四字段，写盘时有、读回来没有。
 */
import { describe, expect, test, beforeEach } from "vitest";
import { vi } from "vitest";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hooks = vi.hoisted(() => ({
  attempts: [] as string[],
  respond: (_thinking: string | undefined) => [] as unknown[],
}));

vi.mock("@earendil-works/pi-ai", () => ({
  lazyApi: (fn: unknown) => fn,
  createProvider: (cfg: { models?: Array<{ id: string }> }) => ({
    getModels: () => cfg.models ?? [],
    streamSimple: (_model: unknown, _context: unknown, opts: { reasoning?: string }) => {
      hooks.attempts.push(opts.reasoning ?? "(未指定)");
      const events = hooks.respond(opts.reasoning);
      return (async function* () { for (const event of events) yield event; })();
    },
  }),
}));

const { LlmRuntime } = await import("../src/llm-runtime.ts");
const { looksTruncated, translateChapterToFile } = await import("../src/translate-one.ts");
import type { Workspace } from "../src/workspace.ts";
import type { PipelineConfig } from "../src/cli-pipeline.ts";

function runtime(historyFile: string | false = false) {
  return LlmRuntime.create({
    configDir: "C:/nonexistent-lightee-config",
    historyFile,
    providers: { fake: { name: "fake", apiKey: "k", models: [{ id: "m" }] } },
  });
}

/** 服务商报 incomplete、思考吃满、无正文——第三次跑批前 8/8 失败的那个形态 */
const incompleteDone = {
  type: "done",
  message: {
    content: [{ type: "thinking", thinking: "草稿".repeat(100) }],
    usage: { input: 5, output: 8000, cacheRead: 0, cacheWrite: 0, reasoning: 8000 },
    stopReason: "length",
    rawStopReason: "incomplete",
  },
};

beforeEach(() => {
  hooks.attempts = [];
  hooks.respond = () => [incompleteDone];
  LlmRuntime.resetThinkingMemory();
});

describe("TR-12 运行时：incomplete 是终态，不进降档梯子", () => {
  test("未正常结束且无正文 → 一次就停，不再 max→xhigh→high→… 逐档烧钱", async () => {
    const error = await runtime()
      .complete("fake/m", [{ role: "user", content: "x" }], { thinking: "max", maxTokens: 8192, retry: { maxRetries: 0 } })
      .then(() => undefined, (e: unknown) => e as Error & { errorMessage?: string });
    // 旧行为：attempts = ["max","xhigh","high","medium","low","minimal","off"]，
    // 每一档都是一整份付费的输出预算。
    expect(hooks.attempts).toEqual(["max"]);
    expect(error?.errorMessage).toBe("模型未正常结束");
  });

  test("废掉的尝试带 rawStopReason——那是唯一需要问「为什么废的」的地方", async () => {
    const error = await runtime()
      .complete("fake/m", [{ role: "user", content: "x" }], { thinking: "max", retry: { maxRetries: 0 } })
      .then(() => undefined, (e: unknown) => e as { wasted?: Array<{ rawStopReason?: string; errorKind: string }> });
    expect(error?.wasted).toHaveLength(1);
    expect(error?.wasted?.[0]?.errorKind).toBe("incomplete");
    expect(error?.wasted?.[0]?.rawStopReason).toBe("incomplete");
  });

  test("正常结束但无正文（empty_response）仍走降档梯子——那是模型真的没话说", async () => {
    hooks.respond = (thinking) =>
      thinking === "high"
        ? [{ type: "done", message: { content: [{ type: "text", text: "译文" }], usage: undefined, stopReason: "stop" } }]
        : [{ type: "done", message: { content: [{ type: "thinking", thinking: "…" }], usage: undefined, stopReason: "stop" } }];
    const result = await runtime().complete("fake/m", [{ role: "user", content: "x" }], { thinking: "max", retry: { maxRetries: 0 } });
    expect(result.text).toBe("译文");
    expect(hooks.attempts).toEqual(["max", "xhigh", "high"]);
  });

  test("废掉的尝试计入 tokenTotals——账本与侧栏必须是同一个数", async () => {
    const llm = runtime();
    await llm
      .complete("fake/m", [{ role: "user", content: "x" }], { thinking: "max", retry: { maxRetries: 0 } })
      .catch(() => undefined);
    // 旧行为：失败调用在侧栏上一个 token 都看不见（只有成功那次会累计）
    expect(llm.getTokenTotals().output).toBe(8000);
    expect(llm.getTokenTotals().input).toBe(5);
  });
});

describe("TR-12 历史回读：TR-11 字段不被 normalizeUsage 洗掉", () => {
  test("reasoning / cost / rawStopReason 写盘后能原样读回", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tr12-history-"));
    const file = join(dir, "llm-history.jsonl");
    hooks.respond = () => [{
      type: "done",
      message: {
        content: [{ type: "thinking", thinking: "想" }, { type: "text", text: "译文" }],
        usage: {
          input: 100, output: 8000, cacheRead: 20, cacheWrite: 0,
          reasoning: 7500, totalTokens: 8120,
          cost: { input: 0.01, output: 0.8, cacheRead: 0.001, cacheWrite: 0, total: 0.811 },
        },
        stopReason: "stop",
        rawStopReason: "completed",
      },
    }];
    const llm = runtime(file);
    await llm.complete("fake/m", [{ role: "user", content: "x" }], { retry: { maxRetries: 0 } });
    const [entry] = await llm.getHistory();
    // 旧 normalizeUsage 硬编码四字段：写进文件的 reasoning/cost 在这里被剥掉
    expect(entry?.usage?.reasoning).toBe(7500);
    expect(entry?.usage?.cost?.total).toBeCloseTo(0.811);
    expect(entry?.rawStopReason).toBe("completed");
  });
});

/**
 * 工具轮的产出必须留在历史里。
 *
 * 与 TR-02（失败尝试不留思考）同一个病：**一次调用最贵的那部分产出没有原始记录**。
 * 2026-08-12 单章实测把它照出来了——工具通道的轮 1 只发工具调用、没有正文，
 * 历史行里 `response` 长度 0、`reasoning` 26508，262 秒、12270 推理 token 的产出
 * 在原始记录里是一片空白。要知道模型登记了什么，只能从回灌的 toolResult 反推。
 *
 * 而「跑批必须给完整原始输出，禁止用推断代替原始数据」是本仓库的标准指令。
 */
describe("工具调用参数落进历史（原始记录不留空白）", () => {
  test("只发工具调用、没有正文的那一轮，参数原样写进历史", async () => {
    const dir = await mkdtemp(join(tmpdir(), "toolcall-history-"));
    const file = join(dir, "llm-history.jsonl");
    const args = { terms: [{ ja: "灯ヒナ", zh: "小灯", type: "person", note: "谐音昵称" }] };
    hooks.respond = () => [{
      type: "done",
      message: {
        content: [
          { type: "thinking", thinking: "想了很久" },
          { type: "toolCall", id: "call_1", name: "register_terms", arguments: args },
        ],
        usage: { input: 5, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 95 },
        stopReason: "toolUse",
        rawStopReason: "completed",
      },
    }];
    const llm = runtime(file);
    // 调用方给了工具 → 只发工具调用不是错误（KA-4）
    await llm.complete("fake/m", [{ role: "user", content: "x" }], {
      retry: { maxRetries: 0 },
      tools: [{ name: "register_terms", description: "登记术语", parameters: { type: "object", properties: {} } }],
    } as never);

    // 落盘的那一行必须自带参数——回读接口能拿到不算数，文件里没有就是没有
    const raw = await readFile(file, "utf8");
    const row = JSON.parse(raw.trim().split(/\r?\n/).at(-1)!);
    expect(row.response).toBe("");           // 正文确实是空的
    expect(row.toolCalls).toHaveLength(1);   // 但产出不是空的
    expect(row.toolCalls[0].name).toBe("register_terms");
    expect(row.toolCalls[0].arguments).toEqual(args);
  });

  /**
   * 发出去的那一半同样不能缺。
   *
   * KA-5 之后术语登记的指令**一个字都不在 prompt 里**——判据在工具 `description`、
   * 形状由 schema 保证。历史只记 messages 的话，导出里看不到任何工具指令，
   * 读的人的合理结论是「我们什么都没告诉模型」。作者看完第一版导出问的正是这句。
   */
  test("发出去的工具定义（description + schema）同样落进历史", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tooldef-history-"));
    const file = join(dir, "llm-history.jsonl");
    const tool = {
      name: "register_terms",
      description: "唯一判据：换一个译者会不会译得不一样？",
      parameters: { type: "object", properties: { terms: { type: "array" } }, required: ["terms"], additionalProperties: false },
    };
    hooks.respond = () => [{
      type: "done",
      message: { content: [{ type: "text", text: "译文" }], usage: undefined, stopReason: "stop" },
    }];
    const llm = runtime(file);
    await llm.complete("fake/m", [{ role: "user", content: "x" }], { retry: { maxRetries: 0 }, tools: [tool] } as never);

    const raw = await readFile(file, "utf8");
    const row = JSON.parse(raw.trim().split(/\r?\n/).at(-1)!);
    expect(row.tools).toHaveLength(1);
    expect(row.tools[0].description).toBe(tool.description);
    expect(row.tools[0].parameters).toEqual(tool.parameters);
  });

  test("没带工具的调用不写空 tools 字段（历史行不为不存在的东西留位）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "notool-history-"));
    const file = join(dir, "llm-history.jsonl");
    hooks.respond = () => [{
      type: "done",
      message: { content: [{ type: "text", text: "译文" }], usage: undefined, stopReason: "stop" },
    }];
    await runtime(file).complete("fake/m", [{ role: "user", content: "x" }], { retry: { maxRetries: 0 } });
    const raw = await readFile(file, "utf8");
    const row = JSON.parse(raw.trim().split(/\r?\n/).at(-1)!);
    expect(row.tools).toBeUndefined();
    expect(row.toolCalls).toBeUndefined();
  });
});

describe("TR-12 截断判定：先信服务商，数标签只是退路", () => {
  const ids = Array.from({ length: 10 }, (_, i) => `p${String(i + 1).padStart(4, "0")}`);
  /** 9/10 段完整闭合、标签配平——启发式的真实盲区（截断恰好落在段落边界） */
  const nineOfTen = ids.slice(0, 9).map((id) => `<paragraph id="${id}">译文</paragraph>`).join("\n");

  test("标签配平且已到 ≥80% → 启发式看不出截断", () => {
    expect(looksTruncated(nineOfTen, ids)).toBe(false);
  });

  test("同样的输出，服务商说 incomplete → 判为截断，进 salvage 而不是整章重译", () => {
    expect(looksTruncated(nineOfTen, ids, true)).toBe(true);
  });

  test("空输出不因 incomplete 判截断——没有可保住的段落，salvage 无意义", () => {
    expect(looksTruncated("", ids, true)).toBe(false);
  });
});

// ===== 翻译链：incomplete 的退路是切批（与降档相对） =====

let root: string;
let ws: Workspace;
let config: PipelineConfig;
const PARAS = 6;

async function makeWorkspace(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), "tr12-split-"));
  ws = { root } as Workspace;
  await mkdir(join(root, "source", "v01"), { recursive: true });
  await mkdir(join(root, "terminology"), { recursive: true });
  await mkdir(join(root, "translations"), { recursive: true });
  await mkdir(join(root, "state"), { recursive: true });
  await writeFile(
    join(root, "source", "manifest.json"),
    JSON.stringify({ book: "测试书", chapters: [{ id: "ch001", title: "第一章", volume: "v01" }] }),
    "utf-8"
  );
  config = {
    project: { name: "测试", srcLang: "ja", tgtLang: "zh" },
    agents: { translator: { model: "deepseek/deepseek-v4-flash", thinking: "high" } },
    translation: { mode: "quality", concurrency: 1, batchChars: 2000, contextWindow: 131072 },
  } as PipelineConfig;
  const src = Array.from({ length: PARAS }, (_, i) => `第${i}段。日本語の本文。`).join("\n\n");
  await writeFile(join(root, "source", "v01", "ch001.md"), src, "utf-8");
}

const idsIn = (user: string): string[] => [...user.matchAll(/<paragraph id="([^"]+)"/g)].map((m) => m[1]!);

/** 前 failTimes 次调用抛「未正常结束」（llm-runtime TR-12 终态的形状），之后正常返回 */
function incompleteThenOkLlm(failTimes: number, log: string[][]) {
  let call = 0;
  return {
    complete: async (_model: string, messages: Array<{ role: string; content: string }>) => {
      const user = messages[messages.length - 1]!.content;
      const ids = idsIn(user);
      log.push(ids);
      call += 1;
      if (call <= failTimes) {
        // 假体必须发运行时**真正会发**的东西：判据是结构化的 `shapeKind`（KA-1），
        // 文案只给人看。此前这里设的是 `errorMessage = "模型未正常结束"`——
        // 那条中文串曾是 llm-runtime 与 translate-one 之间的真实控制流契约。
        const error = new Error("模型未正常结束（stopReason=length）且没有正文") as Error & { shapeKind?: string; errorMessage?: string };
        error.shapeKind = "incomplete";
        error.errorMessage = "模型未正常结束";
        throw error;
      }
      return { text: ids.map((id) => `<paragraph id="${id}">译文${id}</paragraph>`).join("\n") };
    },
  };
}

describe("TR-12 翻译链：思考吃光预算 → 切批重来，不整章原样重发", () => {
  beforeEach(makeWorkspace);

  test("整章单发撞 incomplete → 落到分批通道并交付全部段落", async () => {
    const log: string[][] = [];
    // 旧行为：非 ParagraphGateFailure 一律上抛 → 整章失败（或在运行时里降档）
    await translateChapterToFile(ws, "ch001", incompleteThenOkLlm(1, log) as never, config);
    const out = (await readFile(join(root, "translations", "ch001_zh.md"), "utf-8")).trimEnd();
    expect(out.split("\n\n")).toHaveLength(PARAS);
    expect(log.length).toBeGreaterThan(1);
  });

  test("分批后还撞 → 对半切而不是原样重发（同样的输入引出同样的草稿）", async () => {
    const log: string[][] = [];
    // 第 1 次：整章单发撞；第 2 次：整章一批再撞；之后每一半各自成功
    await translateChapterToFile(ws, "ch001", incompleteThenOkLlm(2, log) as never, config);
    const out = (await readFile(join(root, "translations", "ch001_zh.md"), "utf-8")).trimEnd();
    expect(out.split("\n\n")).toHaveLength(PARAS);
    // 第 3 次调用的段落集必须**小于**第 2 次——切了，而不是原样重发
    expect(log[2]!.length).toBeLessThan(log[1]!.length);
  });
});
