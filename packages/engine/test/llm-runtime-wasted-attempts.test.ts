/**
 * 真实 46 章跑批（2026-08-12）暴露的两件事，都在空响应降档这条路上：
 *
 * 1. 一次逻辑调用成功前废掉的 4 次尝试，**一行账都没有**。EX-01 当初定的是
 *    「一次逻辑调用一行、重试在内部消化」，只留一个 attempts 计数。可在 thinking=max 下
 *    每一次废掉的尝试都烧掉一整个输出预算（实测单次 output 8190 token、真正文本 174 字符），
 *    于是账本少报了数倍花费——而账本存在的全部意义就是回答「钱花在哪」。
 * 2. 降档结果不记忆。每一章都要重走 max→xhigh→high→medium→low，
 *    前四档注定失败。46 章就是 184 次注定失败、且不入账的调用。
 */
import { describe, expect, test, beforeEach, vi } from "vitest";

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

function runtime() {
  return LlmRuntime.create({
    configDir: "C:/nonexistent-lightee-config",
    historyFile: false,
    providers: { fake: { name: "fake", apiKey: "k", models: [{ id: "m" }] } },
  });
}

/** 思考吃光预算、不吐文本——附带 usage，因为这次尝试是**付过钱**的 */
const emptyWithUsage = { type: "done", message: { content: [{ type: "thinking", thinking: "…" }], usage: { input: 100, output: 8190, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" } };
const textDone = { type: "done", message: { content: [{ type: "text", text: "译文" }], usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" } };

beforeEach(() => {
  hooks.attempts = [];
  hooks.respond = () => [emptyWithUsage];
  LlmRuntime.resetThinkingMemory();
});

describe("废掉的尝试要落账", () => {
  test("降档路上每一次空响应都带 usage 报出来，而不是只留一个 attempts 计数", async () => {
    hooks.respond = (thinking) => (thinking === "high" ? [textDone] : [emptyWithUsage]);
    const result = await runtime().complete("fake/m", [{ role: "user", content: "x" }], { thinking: "max", retry: { maxRetries: 0 } });

    expect(result.text).toBe("译文");
    expect(result.attempts).toBe(3);
    // max 与 xhigh 两次废掉的尝试各自成行
    expect(result.wasted).toHaveLength(2);
    expect(result.wasted?.map((w) => w.thinking)).toEqual(["max", "xhigh"]);
    expect(result.wasted?.every((w) => w.errorKind === "empty_response")).toBe(true);
    // 关键：废掉的 output 必须报出来。少报的正是最贵的那部分
    expect(result.wasted?.reduce((sum, w) => sum + (w.usage?.output ?? 0), 0)).toBe(16380);
  });

  test("一次就成时不产出废尝试记录（不制造噪音）", async () => {
    hooks.respond = () => [textDone];
    const result = await runtime().complete("fake/m", [{ role: "user", content: "x" }], { thinking: "max", retry: { maxRetries: 0 } });
    expect(result.attempts).toBe(1);
    expect(result.wasted ?? []).toHaveLength(0);
  });

  test("瞬态错误的尝试也落账——它同样是付过时间的一次网络调用", async () => {
    let seen = 0;
    hooks.respond = () => { seen += 1; return seen === 1 ? [{ type: "error", error: { errorMessage: "503 service unavailable" } }] : [textDone]; };
    const result = await runtime().complete("fake/m", [{ role: "user", content: "x" }], { thinking: "low", retry: { maxRetries: 3, baseDelayMs: 0 } });
    expect(result.wasted).toHaveLength(1);
    expect(result.wasted?.[0]?.errorKind).toBe("transient");
  });
});

describe("没有正文时，思考块与用量必须完整保留", () => {
  /**
   * 服务商报 `status=incomplete`。pi-ai 把**所有** incomplete 一律映射成
   * `stopReason="length"`（openai-responses-shared.js:634 的 switch），不读
   * `incomplete_details.reason`——所以它只说明「没正常结束」，
   * **不能**推出是输出预算不够。
   */
  const incompleteDone = { type: "done", message: { content: [{ type: "thinking", thinking: "推理".repeat(200) }], usage: { input: 100, output: 8192, cacheRead: 0, cacheWrite: 0 }, stopReason: "length" } };

  test("incomplete 且无正文 → 分类为 incomplete，不安一个具体病因", async () => {
    // TR-12 起 incomplete 是终态（不进降档梯子），废尝试从错误对象上取
    hooks.respond = () => [incompleteDone];
    const error = await runtime()
      .complete("fake/m", [{ role: "user", content: "x" }], { thinking: "max", retry: { maxRetries: 0 } })
      .then(() => undefined, (e: unknown) => e as { wasted?: Array<{ errorKind: string; stopReason?: string }> });
    expect(error?.wasted?.map((w) => w.errorKind)).toEqual(["incomplete"]);
    expect(error?.wasted?.[0]?.stopReason).toBe("length");
  });

  test("思考内容与用量随错误一起带出，不被当场丢弃", async () => {
    hooks.respond = () => [incompleteDone];
    const error = await runtime()
      .complete("fake/m", [{ role: "user", content: "x" }], { thinking: "off", retry: { maxRetries: 0 } })
      .then(() => undefined, (e: unknown) => e as Error & { reasoning?: string; reasoningChars?: number; usage?: { output: number } });
    // 此前 reasoning 与 usage 在这里当场丢弃，失败调用在所有记录里只剩一排 0
    expect(error?.reasoning?.length).toBe(400);
    expect(error?.reasoningChars).toBe(400);
    expect(error?.usage?.output).toBe(8192);
  });

  /**
   * 2026-08-12 第二次跑批：四次失败的 output 分别是 16382/16382/16383/16385，
   * 而 models.json 给这个模型配的 maxTokens 正是 **16384**——碰到上限的全失败，
   * 低于上限的全成功。可当时账本里没有 maxTokens 这一栏，报告只能写
   * 「被服务商截断」，把我们自己设的天花板栽给了服务商。
   *
   * 所以本次尝试**发出去的输出预算**必须随尝试一起落账：
   * 少了它，「output=16382」是个孤零零的数字；有了它才是「触顶」。
   */
  test("发出的输出预算随尝试落账——否则无法分辨触顶与服务商行为", async () => {
    hooks.respond = () => [incompleteDone];
    const result = await runtime()
      .complete("fake/m", [{ role: "user", content: "x" }], { thinking: "off", maxTokens: 8192, retry: { maxRetries: 0 } })
      .then(() => undefined, () => undefined);
    expect(result).toBeUndefined();

    // 成功路径同样要带：成功那次离上限多远，是「还能不能再调高档位」的唯一依据
    hooks.respond = () => [textDone];
    const ok = await runtime().complete("fake/m", [{ role: "user", content: "x" }], { thinking: "off", maxTokens: 8192, retry: { maxRetries: 0 } });
    expect(ok.maxTokens).toBe(8192);
  });

  test("废掉的尝试带着当次的输出预算报出来", async () => {
    hooks.respond = () => [incompleteDone];
    const error = await runtime()
      .complete("fake/m", [{ role: "user", content: "x" }], { thinking: "max", maxTokens: 8192, retry: { maxRetries: 0 } })
      .then(() => undefined, (e: unknown) => e as { wasted?: Array<{ maxTokens?: number }> });
    expect(error?.wasted?.map((w) => w.maxTokens)).toEqual([8192]);
  });

  test("没配预算时不编一个——undefined 就是 undefined", async () => {
    hooks.respond = () => [textDone];
    const ok = await runtime().complete("fake/m", [{ role: "user", content: "x" }], { thinking: "off", retry: { maxRetries: 0 } });
    expect(ok.maxTokens).toBeUndefined();
  });

  test("报错说清已产出多少思考，并承认原因未知——不谎称是预算问题", async () => {
    hooks.respond = () => [incompleteDone];
    const error = await runtime()
      .complete("fake/m", [{ role: "user", content: "x" }], { thinking: "off", retry: { maxRetries: 0 } })
      .then(() => undefined, (e: unknown) => e as Error);
    expect(error?.message).toContain("字符思考");
    expect(error?.message).toContain("原因需看服务商原始响应");
  });

  /**
   * TR-12 政策反转：incomplete **不再**走降档梯子。
   *
   * 旧退路的代价实测过：降档能出文本，但那是把用户选的档位偷偷换掉、并把整份
   * 输出预算再烧一遍（46 章 × 每章几档 = 184 次注定失败的付费调用）。
   * 新退路在调用方——translate-one 按段落边界切批（见 tr12-incomplete-terminal），
   * 「产品不能因此不能用」这条底线由切批保住，不再由降档保。
   */
  test("incomplete 不进降档梯子——一次就终止，退路交给调用方切批", async () => {
    hooks.respond = () => [incompleteDone];
    const error = await runtime()
      .complete("fake/m", [{ role: "user", content: "x" }], { thinking: "max", retry: { maxRetries: 0 } })
      .then(() => undefined, (e: unknown) => e as Error & { errorMessage?: string });
    expect(hooks.attempts).toEqual(["max"]);
    expect(error?.errorMessage).toBe("模型未正常结束");
  });
});

describe("降档结果要记住", () => {
  test("同一模型第二次调用直接从上次成功的档位起步，不再重走注定失败的四档", async () => {
    hooks.respond = (thinking) => (thinking === "high" ? [textDone] : [emptyWithUsage]);
    const llm = runtime();

    await llm.complete("fake/m", [{ role: "user", content: "x" }], { thinking: "max", retry: { maxRetries: 0 } });
    expect(hooks.attempts).toEqual(["max", "xhigh", "high"]);

    hooks.attempts = [];
    await llm.complete("fake/m", [{ role: "user", content: "y" }], { thinking: "max", retry: { maxRetries: 0 } });
    // 第二次一步到位：这正是 46 章书里省下的 184 次调用
    expect(hooks.attempts).toEqual(["high"]);
  });

  test("记忆按模型分家——换模型不继承上一个模型的档位结论", async () => {
    hooks.respond = (thinking) => (thinking === "high" ? [textDone] : [emptyWithUsage]);
    const llm = LlmRuntime.create({
      configDir: "C:/nonexistent-lightee-config",
      historyFile: false,
      providers: { fake: { name: "fake", apiKey: "k", models: [{ id: "m" }, { id: "n" }] } },
    });
    await llm.complete("fake/m", [{ role: "user", content: "x" }], { thinking: "max", retry: { maxRetries: 0 } });

    hooks.attempts = [];
    await llm.complete("fake/n", [{ role: "user", content: "x" }], { thinking: "max", retry: { maxRetries: 0 } });
    expect(hooks.attempts[0]).toBe("max");
  });

  test("请求的档位低于记忆时按请求走——记忆只用来省掉注定失败的高档，不抬高用户的选择", async () => {
    hooks.respond = (thinking) => (thinking === "high" ? [textDone] : [emptyWithUsage]);
    const llm = runtime();
    await llm.complete("fake/m", [{ role: "user", content: "x" }], { thinking: "max", retry: { maxRetries: 0 } });

    hooks.attempts = [];
    hooks.respond = () => [textDone];
    await llm.complete("fake/m", [{ role: "user", content: "x" }], { thinking: "off", retry: { maxRetries: 0 } });
    expect(hooks.attempts).toEqual(["off"]);
  });
});
