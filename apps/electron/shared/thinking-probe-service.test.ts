/**
 * `ai.thinking.probe` 的编排部分（纯判定见 thinking-probe.test.ts）。
 *
 * 这里钉住三件容易做错的事：
 *  1. 每个候选档位必须**用自己的临时配置**发出去——共用一份 map 会让 clamp 介入，
 *     探测结论就成了「凡是没报错的都支持」；
 *  2. 临时 map 只能存在于内存，**绝不能写进用户的 models.json 再改回来**——
 *     中途失败会把「全档位可用」这种没有依据的断言留在配置里；
 *  3. 探测结果要落盘，且只覆盖 thinkingLevelMap，不碰模型的其他字段。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIpcService, type EngineWiring } from "./ipc-service.js";
import type { CreateLlmOptions } from "./llm-types.js";
import { writeLighteeModels, writeLighteeAuth } from "./lightee-config.js";

let configDir = "";
const previousConfigDir = process.env.LIGHTEE_CONFIG_DIR;

/** 每次 createLlm 拿到的候选字符串（顺序即探测顺序） */
let seenCandidates: Array<string | null | undefined> = [];
/** 这些候选会被「服务商」拒绝 */
let rejected = new Set<string>();
/** 这些候选会回传思考内容 */
let reasoned = new Set<string>();

function wiringWithProbe(): EngineWiring {
  const stub = {
    importFile: (async () => { throw new Error("unused"); }) as never,
    previewImport: (async () => { throw new Error("unused"); }) as never,
    prepareTerminology: (async () => { throw new Error("unused"); }) as never,
    translateChapterToFile: (async () => { throw new Error("unused"); }) as never,
    runChapterPipeline: (async () => { throw new Error("unused"); }) as never,
    recoverChapterPromotion: (async () => { throw new Error("unused"); }) as never,
    recoverChapterPromotionInTransaction: (async () => { throw new Error("unused"); }) as never,
    reviewChapter: (async () => { throw new Error("unused"); }) as never,
    runBookReview: (async () => { throw new Error("unused"); }) as never,
    confirm: { loadSession: (() => undefined) as never, saveSession: (() => undefined) as never, verdict: (() => undefined) as never, finishSession: (() => undefined) as never },
    exportChapter: (async () => { throw new Error("unused"); }) as never,
  };
  return {
    ...stub,
    createLlm: (options?: CreateLlmOptions) => {
      // 候选字符串藏在临时 map 里：只有 high 通向它（thinking-probe.probeLevelMap）
      const provider = options?.providers?.acme;
      const candidate = provider?.models?.[0]?.thinkingLevelMap?.high;
      seenCandidates.push(candidate);
      return {
        complete: async () => {
          if (typeof candidate !== "string" || rejected.has(candidate)) throw new Error(`unsupported reasoning effort: ${String(candidate)}`);
          return { text: "OK", reasoning: reasoned.has(candidate) ? "思考中…" : undefined };
        },
        listModels: () => ["acme/m"],
      };
    },
  } as EngineWiring;
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "lightee-probe-cfg-"));
  process.env.LIGHTEE_CONFIG_DIR = configDir;
  seenCandidates = [];
  rejected = new Set();
  reasoned = new Set();
  await writeLighteeModels({
    acme: { name: "Acme", baseUrl: "https://api.acme.test/v1", api: "openai-completions", models: [{ id: "m", name: "M", contextWindow: 65536, maxTokens: 4096 }] },
  });
  await writeLighteeAuth({ acme: { type: "api_key", key: "sk-test" } });
});

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.LIGHTEE_CONFIG_DIR;
  else process.env.LIGHTEE_CONFIG_DIR = previousConfigDir;
  await rm(configDir, { recursive: true, force: true });
});

function envelope(command: string, payload: unknown) {
  return { version: 1, requestId: `${command}-probe`, command, payload };
}

async function diskModel(): Promise<{ name?: string; contextWindow?: number; maxTokens?: number; thinkingLevelMap?: Record<string, string | null> }> {
  const raw = JSON.parse(await readFile(join(configDir, "models.json"), "utf-8")) as { providers: Record<string, { models: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number; thinkingLevelMap?: Record<string, string | null> }> }> };
  return raw.providers.acme!.models.find((model) => model.id === "m")!;
}

describe("ai.thinking.probe 编排", () => {
  it("逐档试探：每档一次调用，且每次发出的候选字符串各不相同", async () => {
    const service = createIpcService({ engine: wiringWithProbe() });
    const result = await service.invoke(envelope("ai.thinking.probe", { providerId: "acme", modelId: "m" }));
    expect(result.ok).toBe(true);
    expect(seenCandidates).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("被拒的档位写成 null，被接受的原样映射，并落盘", async () => {
    rejected = new Set(["minimal", "xhigh", "max"]);
    const service = createIpcService({ engine: wiringWithProbe() });
    const result = await service.invoke(envelope("ai.thinking.probe", { providerId: "acme", modelId: "m" }));
    expect(result.ok).toBe(true);

    const model = await diskModel();
    expect(model.thinkingLevelMap).toEqual({ off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null });
  });

  it("只覆盖 thinkingLevelMap，模型的其他字段原样保留", async () => {
    const service = createIpcService({ engine: wiringWithProbe() });
    await service.invoke(envelope("ai.thinking.probe", { providerId: "acme", modelId: "m" }));
    const model = await diskModel();
    expect(model.name).toBe("M");
    expect(model.contextWindow).toBe(65536);
    expect(model.maxTokens).toBe(4096);
  });

  it("临时探测配置绝不落盘——中途看到的磁盘内容不含单档 map", async () => {
    // 探测进行中读一次磁盘：此时若实现是「写临时 map → 调用 → 改回」，就会读到它
    let midProbe: Record<string, string | null> | undefined;
    const wiring = wiringWithProbe();
    const inner = wiring.createLlm;
    const spying: EngineWiring = {
      ...wiring,
      createLlm: (options?: CreateLlmOptions) => {
        const bridge = inner(options);
        return {
          ...bridge,
          complete: async (...args: Parameters<typeof bridge.complete>) => {
            midProbe ??= (await diskModel()).thinkingLevelMap;
            return bridge.complete(...args);
          },
        };
      },
    };
    const service = createIpcService({ engine: spying });
    await service.invoke(envelope("ai.thinking.probe", { providerId: "acme", modelId: "m" }));
    expect(midProbe).toBeUndefined();
  });

  it("每档的原始结论一并返回——「接受但没回传思考内容」不能被折进 map", async () => {
    reasoned = new Set(["high", "max"]);
    const service = createIpcService({ engine: wiringWithProbe() });
    const result = await service.invoke(envelope("ai.thinking.probe", { providerId: "acme", modelId: "m" }));
    expect(result.ok).toBe(true);
    const value = (result as { value: { outcomes: Array<{ candidate: string; accepted: boolean; reasoned: boolean }> } }).value;
    expect(value.outcomes.filter((outcome) => outcome.reasoned).map((outcome) => outcome.candidate)).toEqual(["high", "max"]);
    // 全部被接受 → 全档位可用，与是否回传思考内容无关
    expect(value.outcomes.every((outcome) => outcome.accepted)).toBe(true);
  });

  it("模型不存在 → 明确报错，不写任何配置", async () => {
    const service = createIpcService({ engine: wiringWithProbe() });
    const result = await service.invoke(envelope("ai.thinking.probe", { providerId: "acme", modelId: "ghost" }));
    expect(result.ok).toBe(false);
    expect((await diskModel()).thinkingLevelMap).toBeUndefined();
  });
});
