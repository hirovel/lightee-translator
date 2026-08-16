/**
 * 配置域服务（RH-11 / design/ipc-service-decomposition.md §2）。
 *
 * 归属：`settings.read/write`、全部 `ai.*` 命令、以及供翻译/审校编排使用的
 * `pipelineConfig` / `resolveAgent` / `resolveReviewAgent` 解析。
 *
 * 写权威：工作区 `config.json` 由本服务的 `configMutation` 独占（ADR-0005）；
 * `~/.lightee/models.json` 与 `auth.json` 走 `lightee-config.ts` 的 mutate 临界区。
 */
import { basename, join, resolve } from "node:path";
import { atomicWriteJson, exists, readJson, readText } from "../atomic-file.js";
import {
  authSecret,
  lighteeAuthPath,
  lighteeModelsPath,
  mutateLighteeAuth,
  mutateLighteeModels,
  readLighteeAuth,
  readLighteeModels,
  readPresetRevision,
  writeLighteeModelsWithRevision,
  PRESET_PROVIDERS,
  PRESET_REVISION,
  RETIRED_PRESET_PROVIDER_IDS,
  type LighteeProviderConfig,
} from "../lightee-config.js";
import { errorFor, failure, success, type AnyResult } from "../ipc-result.js";
import { PROBE_CANDIDATES, PROBE_REQUEST_LEVEL, buildThinkingLevelMap, probeLevelMap, type ProbeOutcome } from "../thinking-probe.js";
import { readContextLength } from "../model-metadata.js";
import type { IpcEventMap, IpcRequestMap, JsonValue, SettingsSnapshot } from "../ipc-contract.js";
import type { ServiceContext } from "./service-context.js";
import type { WorkspacePipelineConfig } from "../service-types.js";

const DEFAULT_SETTINGS: Record<string, JsonValue> = {
  quoteStyle: "zh",
  contextWindow: 131072,
  // batchChars 的缺省值必须与 pipelineConfig 实际使用的值一致（RH-19）：
  // 设置面板读到 2000、引擎却按 4000 分批，就是另一种形式的撒谎。
  translation: { batchChars: 4000, styleAnchor: "" },
  editor: { fontSize: 18, sourceColor: "faint", paragraphGap: "natural", termHighlight: "highlight", sourceLink: true, focusCenter: true, cursorAnimate: true, cursorBlink: false, cursorShape: "block", sourceEditable: false },
};

/**
 * 可写设置白名单。**每一项都必须有真实的消费点**（RH-19 / A-7）——
 * 写得进去、读得出来、但引擎不看的设置项属于对用户撒谎，一律不留在这里。
 * 全表 → 消费点对照见 `docs/tickets/RH-19-settings-honesty.md` 的审计表。
 *
 * `translation.concurrency` 已移除：桌面端每次只编排一个章节，并发度在这条路径上
 * 无从生效。批量翻译路径落地时（RH-15 之后）再连同消费点一起加回来。
 */
const ALLOWED_SETTINGS = new Set([
  "quoteStyle",
  "contextWindow",
  "translation.batchChars",
  "translation.guide",
  "translation.styleAnchor",
  // 作者审校规则：消费点在 bookReviewRun → runBookReview.authorRules（注入通读窗口）
  "review.rules",
  "editor.fontSize",
  "editor.sourceColor",
  "editor.paragraphGap",
  "editor.termHighlight",
  "editor.sourceLink",
  "editor.focusCenter",
  "editor.cursorAnimate",
  "editor.cursorBlink",
  "editor.cursorShape",
  "editor.sourceEditable",
]);

export class ConfigService {
  constructor(private readonly ctx: ServiceContext) {}

  // ===== 注入面转发（搬移过来的方法体保持零改动） =====
  private get engine(): ServiceContext["engine"] { return this.ctx.engine; }
  private get llm(): ServiceContext["llm"] { return this.ctx.llm; }
  private workspace(workspaceId: string) { return this.ctx.workspace(workspaceId); }
  private emitAgentStatus(
    agent: string,
    status: IpcEventMap["agent.status"]["status"],
    message: string,
    provenance: Partial<Pick<IpcEventMap["agent.status"], "workspaceId" | "chapterId" | "runId" | "operation">>,
  ): void { this.ctx.emitAgentStatus(agent, status, message, provenance); }
  private openExternal(url: string): Promise<boolean> { return this.ctx.openExternal(url); }
  private openConfigFile(kind: "models" | "auth"): Promise<boolean> { return this.ctx.openConfigFile(kind); }
  private readRevision(root: string, key: string): Promise<number> { return this.ctx.readRevision(root, key); }
  private writeRevision(root: string, key: string, revision: number): Promise<void> { return this.ctx.writeRevision(root, key, revision); }
  private markBookReviewStale(root: string, reason: string): Promise<void> { return this.ctx.markBookReviewStale(root, reason); }
  private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> { return this.ctx.enqueue(key, fn); }
  private trackWrite<T>(promise: Promise<T>): Promise<T> { return this.ctx.trackWrite(promise); }

  /**
   * 工作区 config.json 的唯一写权威（ADR-0005 / design/write-authority.md）。
   * 全部 read-modify-write 必须整段进入同一队列：读、改、写之间不得让出，
   * 否则并发写入互相覆盖且都返回 ok:true（DEF-02）。
   * 队列 key 用 resolve(root) 归一，避免同一工作区因路径写法不同分裂成多把锁。
   */
  private configMutation<T>(root: string, fn: (current: Record<string, JsonValue>, configPath: string) => Promise<T>): Promise<T> {
    const configPath = join(root, "config.json");
    return this.trackWrite(this.enqueue(`${resolve(root)}:config`, async () => {
      const current = await readJson<Record<string, JsonValue>>(configPath, {});
      return fn(current, configPath);
    }));
  }

  /**
   * settings 中的数值项：非法/越界一律钳制并 console.warn，不静默取默认——
   * 用户改了一个数字却毫无反应，比报个警更难查。
   */
  private clampSetting(value: JsonValue | undefined, key: string, min: number, max: number, fallback: number): number {
    if (value === undefined) return fallback;
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) { console.warn(`[lightee] 设置 ${key} 不是数字（${String(value)}），改用 ${fallback}`); return fallback; }
    const clamped = Math.min(max, Math.max(min, Math.round(numeric)));
    if (clamped !== numeric) console.warn(`[lightee] 设置 ${key}=${numeric} 超出 [${min}, ${max}]，已钳制为 ${clamped}`);
    return clamped;
  }

  /**
   * 当前模型的上下文窗口（RH-19 / A-7）。优先级：models.json 中该模型的定义 →
   * 工作区 settings.contextWindow → 131072。模型自己声明的窗口永远比用户的猜测准。
   */
  private async resolveContextWindow(model: string, settingsValue: JsonValue | undefined): Promise<number> {
    const slash = model.indexOf("/");
    const providerId = slash > 0 ? model.slice(0, slash) : model;
    const modelId = slash > 0 ? model.slice(slash + 1) : "";
    try {
      const defined = (await readLighteeModels())[providerId]?.models?.find((candidate) => candidate.id === modelId)?.contextWindow;
      if (typeof defined === "number" && defined > 0) return defined;
    } catch { /* models.json 不可读 → 退到 settings */ }
    return this.clampSetting(settingsValue, "contextWindow", 8_192, 4_194_304, 131_072);
  }

  /**
   * 该模型的输出预算，取自作者在模型详情里填的 maxTokens。
   *
   * 这一栏此前是**装饰性的**：它写进 models.json、进 pi-ai 的模型注册表当元数据，
   * 然后就断了——两个适配器都只在请求侧显式传了 maxTokens 才发 `max_tokens`
   * （openai-completions.js:531 / openai-responses.js:213），而 PipelineConfig
   * 从来没有组装过这一栏。作者填 65536 也好、填 8192 也好，一个字都没走到线上。
   *
   * 后果不是「无限制」而是**拿服务商未公开的保守默认值**：deepseek-v4-flash
   * 官方上限 384K，实测却在 ~8192 被砍，推理写满后正文根本没轮到。
   *
   * 未填时返回 undefined —— **不编造默认值**。宁可维持现状（服务商默认），
   * 也不替作者猜一个数字然后以事实的形态用下去；真被截断了现在会如实报
   * `truncated` 并指向这一栏，而不是伪装成「空响应」去降思考档。
   */
  private async resolveMaxTokens(model: string): Promise<number | undefined> {
    const slash = model.indexOf("/");
    const providerId = slash > 0 ? model.slice(0, slash) : model;
    const modelId = slash > 0 ? model.slice(slash + 1) : "";
    try {
      const defined = (await readLighteeModels())[providerId]?.models?.find((candidate) => candidate.id === modelId)?.maxTokens;
      if (typeof defined === "number" && Number.isFinite(defined) && defined > 0) return defined;
    } catch { /* models.json 不可读 → 不传，维持服务商默认 */ }
    return undefined;
  }

  async pipelineConfig(root: string): Promise<WorkspacePipelineConfig> {
    const book = await readText(join(root, "book.yaml"), "");
    const name = /^name:\s*(.+)$/m.exec(book)?.[1]?.trim() ?? basename(root);
    const srcLang = /^srcLang:\s*(.+)$/m.exec(book)?.[1]?.trim() ?? "ja";
    const tgtLang = /^tgtLang:\s*(.+)$/m.exec(book)?.[1]?.trim() ?? "zh";
    const aiModel = await this.readAiModel(root);
    // 确定的模型不可更改：仅允许工作区配置；未配置时用项目默认 v4-flash（绝不取注册顺序第一个）
    const model = aiModel ?? "deepseek/deepseek-v4-pro";
    const maxTokens = await this.resolveMaxTokens(model);
    // 思考强度：工作区 ai.thinking 优先；缺省 high（deepseek 系列默认 max）
    const aiThinking = await (async () => {
      try { const raw = await readJson<{ ai?: { thinking?: string } }>(join(root, "config.json"), {}); return raw?.ai?.thinking ?? "high"; } catch { return "high"; }
    })();
    // 审校思考：ai.reviewThinking（缺省 high，作者裁定 2026-08-13）——默认面向质量；
    // 旧缺省 low 的理由（「低思考防 JSON 漂移」）是预防性假设、无实测依据，不拿嫌疑定默认值
    const reviewThinking = await (async () => {
      try { const raw = await readJson<{ ai?: { reviewThinking?: string } }>(join(root, "config.json"), {}); return raw?.ai?.reviewThinking ?? "high"; } catch { return "high"; }
    })();
    // RH-19 / A-7：以下四项此前是硬编码常量，用户在 settings 里改了完全没用。
    // 现在一律走 settings 的合并视图（缺省值来自 DEFAULT_SETTINGS，与旧硬编码值一致）。
    const settings = this.mergeSettings(await readJson<Record<string, JsonValue>>(join(root, "config.json"), {}));
    const translationSettings = (settings.translation ?? {}) as Record<string, JsonValue>;
    const guide = typeof translationSettings.guide === "string" && translationSettings.guide.trim() ? translationSettings.guide : undefined;
    const quoteStyle: "zh" | "jp" = settings.quoteStyle === "jp" ? "jp" : "zh";
    return {
      project: { name, srcLang, tgtLang },
      agents: {
        // maxTokens 只在作者填了才带上——见 resolveMaxTokens 的注释：
        // 此前这一栏根本没被组装，面板里的值一步都没走到线上。
        translator: { model, thinking: aiThinking, ...(maxTokens === undefined ? {} : { maxTokens }) },
        reviewer: { model, thinking: reviewThinking },
        // 没有 terminologist：ADR-0007 拆掉译前提取阶段之后，术语登记跟在翻译的同一次
        // 请求里完成，用的就是 translator 这一档。此前这里还组装着一个 terminologist，
        // 引擎全无消费者，界面上那个旋钮因此拧了也没有任何效果。
      },
      translation: {
        mode: "balanced",
        // 桌面端一次只编排一个章节（chapterIds 长度恒为 1），并发度在这条路径上无从生效。
        // 因此不接 settings —— 详见 RH-19 的 ALLOWED_SETTINGS 审计表。
        concurrency: 1,
        batchChars: this.clampSetting(translationSettings.batchChars, "translation.batchChars", 500, 20_000, 4_000),
        quoteStyle,
        staging: true,
        guide,
        contextWindow: await this.resolveContextWindow(model, settings.contextWindow),
        // 预算与窗口是两件事：窗口填多大都不该顺带改变「塞多少书进上下文」。
        ...(typeof translationSettings.styleAnchor === "string" && translationSettings.styleAnchor.trim()
          ? { styleAnchor: translationSettings.styleAnchor }
          : {}),
      },
    };
  }

  // ===== AI 模型配置（设置面板接入真实 LLM API） =====
  /** 首次使用：Lightee models.json 不存在时写入默认预置服务商（轻度使用开箱即用） */
  private async ensureLighteeModels(): Promise<void> {
    if (await exists(lighteeModelsPath())) return;
    // 存在性检查必须与写入同处一个临界区，否则两路并发首次初始化会互相覆盖。
    await mutateLighteeModels(async (providers) => {
      if (await exists(lighteeModelsPath())) return { providers: null, result: undefined };
      const defaults: Record<string, LighteeProviderConfig> = { ...providers };
      for (const preset of PRESET_PROVIDERS) {
        defaults[preset.id] = { name: preset.name, baseUrl: preset.baseUrl, api: preset.api, models: preset.models };
      }
      return { providers: defaults, result: undefined };
    });
  }
  /**
   * 预置对账（作者实测：设置页里还留着已撤下的服务商，点开全是停用的模型 id）。
   *
   * 病根：`ensureLighteeModels` 只在文件**不存在**时写一次预置。老用户的 models.json
   * 是首次启动那天的快照，此后 MX-1 的裁剪一次都没到过他们那里。
   *
   * 对账的边界——只动**我们自己发的默认值**，不碰用户的东西：
   * - 预置服务商：模型清单换成当前预置（停用 id 由此消失），逐个模型保留用户探测出的
   *   `thinkingLevelMap`（那是实测结果，不是默认值）；
   * - 已撤下的预置服务商：**配过密钥的一律保留**——用户往里填过密钥就是做过选择，
   *   撤下的是预置不是能力（ADR：作者裁定）。没密钥的才移除；
   * - 用户自己加的服务商（不在两张表里）：一律不动。
   */
  private async reconcilePresetProviders(): Promise<void> {
    if (await readPresetRevision() >= PRESET_REVISION) return;
    const auth = await readLighteeAuth();
    const providers = await readLighteeModels();
    const next: Record<string, LighteeProviderConfig> = { ...providers };
    for (const preset of PRESET_PROVIDERS) {
      const existing = providers[preset.id];
      if (!existing) { next[preset.id] = { name: preset.name, baseUrl: preset.baseUrl, api: preset.api, models: preset.models }; continue; }
      const probed = new Map((existing.models ?? []).map((model) => [model.id, model.thinkingLevelMap]));
      next[preset.id] = {
        ...existing,
        name: preset.name, baseUrl: preset.baseUrl, api: preset.api,
        models: preset.models.map((model) => {
          const keep = probed.get(model.id);
          return keep ? { ...model, thinkingLevelMap: keep } : model;
        }),
      };
    }
    for (const retired of RETIRED_PRESET_PROVIDER_IDS) {
      if (!next[retired]) continue;
      if (authSecret(auth[retired])) continue; // 配过密钥 = 用户的选择，不替他删
      delete next[retired];
    }
    await writeLighteeModelsWithRevision(next, PRESET_REVISION);
  }

  private async aiProvidersList(): Promise<Array<{ id: string; name: string; baseUrl: string; keyUrl?: string; hasKey?: boolean; models: Array<{ id: string; name: string; contextWindow?: number; maxTokens?: number; thinkingLevelMap?: Record<string, string | null> }> }>> {
    // Lightee 自己的 models.json（发布独立；ensureLighteeModels 保证首次已写入默认预置，
    // 因此不存在回退到 ~/.pi/agent 的路径——那是早期共用 pi 配置的遗留分支，M-5 已删除）
    await this.ensureLighteeModels();
    await this.reconcilePresetProviders();
    const configPath = lighteeModelsPath();
    const auth = await readLighteeAuth();
    try {
      const raw = await readJson<{ providers?: Record<string, { name?: string; baseUrl?: string; api?: "openai-responses" | "openai-completions"; models?: Array<{ id: string; name?: string }> }> }>(configPath, {});
      return Object.entries(raw.providers ?? {}).map(([id, cfg]) => {
        const preset = PRESET_PROVIDERS.find((candidate) => candidate.id === id);
        return {
          id,
          name: cfg.name ?? id,
          baseUrl: cfg.baseUrl ?? "",
          // 服务商编辑器要原样回填 api——漏了它，保存时会把 openai-responses 覆盖成默认值
          api: cfg.api,
          keyUrl: preset?.keyUrl,
          // 解密失败的条目（sealed 标记仍在）→ authSecret 返回 undefined → 如实显示为「无密钥」
          hasKey: Boolean(authSecret(auth[id])),
          models: (cfg.models ?? []).map((model) => ({ id: model.id, name: model.name ?? model.id, contextWindow: (model as { contextWindow?: number }).contextWindow, maxTokens: (model as { maxTokens?: number }).maxTokens, thinkingLevelMap: (model as { thinkingLevelMap?: Record<string, string | null> }).thinkingLevelMap })),
        };
      });
    } catch {
      return [];
    }
  }
  private async readAiModel(root: string): Promise<string | null> {
    try { const raw = await readJson<{ ai?: { model?: string } }>(join(root, "config.json"), {}); return raw?.ai?.model ?? null; } catch { return null; }
  }
  private async readAiThinking(root: string): Promise<string | null> {
    try { const raw = await readJson<{ ai?: { thinking?: string } }>(join(root, "config.json"), {}); return raw?.ai?.thinking ?? null; } catch { return null; }
  }
  /**
   * 统一模型解析（翻译）：工作区 config.json 的 ai.model / ai.thinking 为唯一来源；
   * 未配置时用项目默认 deepseek-v4-flash。确定模型绝不变更、绝不回退到注册顺序第一个。
   */
  private async resolveAgent(root: string): Promise<{ model: string; thinking: string }> {
    const model = (await this.readAiModel(root)) ?? "deepseek/deepseek-v4-pro";
    const thinking = (await this.readAiThinking(root)) ?? "high";
    return { model, thinking };
  }
  private async readAiReviewThinking(root: string): Promise<string | null> {
    try { const raw = await readJson<{ ai?: { reviewThinking?: string } }>(join(root, "config.json"), {}); return raw?.ai?.reviewThinking ?? null; } catch { return null; }
  }
  /**
   * 审校类 LLM（章节审校 / 全文 L2 / Reduce）统一解析：模型同工作区配置（不可变更）；
   * thinking 用 ai.reviewThinking（缺省 high，作者裁定 2026-08-13：默认面向质量，
   * 「低思考防格式漂移」无实测依据；嫌超时/费钱的用户可在设置里降档）。翻译仍用 ai.thinking。
   */
  async resolveReviewAgent(root: string): Promise<{ model: string; thinking: string }> {
    const model = (await this.readAiModel(root)) ?? "deepseek/deepseek-v4-pro";
    const thinking = (await this.readAiReviewThinking(root)) ?? "high";
    return { model, thinking };
  }
  async listAiProviders(request: IpcRequestMap["ai.providers.list"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    // 展示与执行必须使用同一个有效配置；缺省值只解析，不写回用户文件。
    const { model: current, thinking } = await this.resolveAgent(workspace.root);
    const reviewThinking = await (async () => {
      try { const raw = await readJson<{ ai?: { reviewThinking?: string } }>(join(workspace.root, "config.json"), {}); return raw?.ai?.reviewThinking ?? "high"; } catch { return "high"; }
    })();
    return success({ providers: await this.aiProvidersList(), current, currentProvider: current.split("/")[0] ?? "", currentThinking: thinking, reviewThinking });
  }
  async writeAiKey(request: IpcRequestMap["ai.key.write"]): Promise<AnyResult> {
    // 确保 Lightee 默认预置存在（绝不导入 pi 配置——保持完全独立）
    await this.ensureLighteeModels();
    // 写 Lightee 自己的 auth.json（~/.lightee/auth.json，0600 权限）——发布后不依赖 pi
    await mutateLighteeAuth((auth) => {
      auth[request.providerId] = { type: "api_key", key: request.apiKey };
      return { auth, result: undefined };
    });
    this.emitAgentStatus("terminologist", "done", `API Key 已保存：${request.providerId}`, { operation: "configuration" });
    return success({ providerId: request.providerId, hasKey: true });
  }
  async writeAiModel(request: IpcRequestMap["ai.model.write"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    return this.configMutation(workspace.root, async (current, configPath) => {
      const next = { ...current, ai: { ...(current.ai as Record<string, JsonValue> | undefined), model: request.model } };
      await atomicWriteJson(configPath, next);
      return success({ model: request.model });
    });
  }
  async testAi(request: IpcRequestMap["ai.test"]): Promise<AnyResult> {
    if (!this.engine) return failure(errorFor("unsupported", "Engine wiring is unavailable", false));
    const workspace = this.workspace(request.workspaceId);
    const runtime = this.llm ? null : this.engine.createLlm();
    const llm = this.llm ?? runtime!;
    const model = request.model ?? (await this.readAiModel(workspace.root)) ?? "deepseek/deepseek-v4-pro";
    try {
      const result = await llm.complete(model, [
        { role: "system", content: "你是一个连接测试助手。收到 ping 时只回复 OK。" },
        { role: "user", content: "ping" },
      ], {});
      return success({ ok: true, message: "连接成功", model });
    } catch (error) {
      return success({ ok: false, message: error instanceof Error ? error.message : String(error), model });
    }
  }

  // 管理：添加/删除服务商、模型（参考 pi models.json 结构；写入 Lightee 自己的配置）
  async upsertAiProvider(request: IpcRequestMap["ai.provider.upsert"]): Promise<AnyResult> {
    // 保留既有模型列表 + 覆盖服务商元数据：读与写必须同处一个临界区。
    await mutateLighteeModels((providers) => {
      const previous = providers[request.providerId];
      providers[request.providerId] = {
        ...previous,
        name: request.name,
        baseUrl: request.baseUrl,
        api: request.api,
        models: previous?.models ?? [],
      };
      return { providers, result: undefined };
    });
    this.emitAgentStatus("terminologist", "done", `服务商已添加：${request.providerId}`, { operation: "configuration" });
    return success({ providerId: request.providerId });
  }
  async deleteAiProvider(request: IpcRequestMap["ai.provider.delete"]): Promise<AnyResult> {
    await mutateLighteeModels((providers) => {
      delete providers[request.providerId];
      return { providers, result: undefined };
    });
    this.emitAgentStatus("terminologist", "done", `服务商已删除：${request.providerId}`, { operation: "configuration" });
    return success({ providerId: request.providerId });
  }
  async upsertAiModel(request: IpcRequestMap["ai.model.upsert"]): Promise<AnyResult> {
    await mutateLighteeModels((providers) => {
      const provider = providers[request.providerId] ?? { models: [] };
      const models = provider.models ?? [];
      const existing = models.find((model) => model.id === request.modelId);
      // 未传的字段一律不动：⟳ 重新拉模型列表时只带 id/name，不该顺手抹掉
      // 用户探测出来的思考档位映射或手填的上下文窗口。
      if (existing) {
        existing.name = request.modelName ?? existing.name;
        if (request.thinkingLevelMap !== undefined) existing.thinkingLevelMap = request.thinkingLevelMap;
        if (request.contextWindow !== undefined) existing.contextWindow = request.contextWindow;
        if (request.maxTokens !== undefined) existing.maxTokens = request.maxTokens;
      } else {
        models.push({
          id: request.modelId,
          name: request.modelName ?? request.modelId,
          ...(request.thinkingLevelMap !== undefined ? { thinkingLevelMap: request.thinkingLevelMap } : {}),
          ...(request.contextWindow !== undefined ? { contextWindow: request.contextWindow } : {}),
          ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
        });
      }
      provider.models = models;
      providers[request.providerId] = provider;
      return { providers, result: undefined };
    });
    this.emitAgentStatus("terminologist", "done", `模型已添加：${request.modelId}`, { operation: "configuration" });
    return success({ providerId: request.providerId, modelId: request.modelId });
  }
  async deleteAiModel(request: IpcRequestMap["ai.model.delete"]): Promise<AnyResult> {
    await mutateLighteeModels((providers) => {
      const provider = providers[request.providerId];
      if (!provider) return { providers: null, result: undefined };
      provider.models = (provider.models ?? []).filter((model) => model.id !== request.modelId);
      return { providers, result: undefined };
    });
    this.emitAgentStatus("terminologist", "done", `模型已删除：${request.modelId}`, { operation: "configuration" });
    return success({ providerId: request.providerId, modelId: request.modelId });
  }

  async deleteAiKey(request: IpcRequestMap["ai.key.delete"]): Promise<AnyResult> {
    await mutateLighteeAuth((auth) => {
      delete auth[request.providerId];
      return { auth, result: undefined };
    });
    this.emitAgentStatus("terminologist", "done", `已清除 ${request.providerId} 的密钥`, { operation: "configuration" });
    return success({ providerId: request.providerId });
  }
  async writeAiThinking(request: IpcRequestMap["ai.thinking.write"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    return this.configMutation(workspace.root, async (current, configPath) => {
      const next = { ...current, ai: { ...(current.ai as Record<string, JsonValue> | undefined), thinking: request.thinking } };
      await atomicWriteJson(configPath, next);
      return success({ thinking: request.thinking });
    });
  }
  async writeAiReviewThinking(request: IpcRequestMap["ai.reviewThinking.write"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    return this.configMutation(workspace.root, async (current, configPath) => {
      const next = { ...current, ai: { ...(current.ai as Record<string, JsonValue> | undefined), reviewThinking: request.thinking } };
      await atomicWriteJson(configPath, next);
      return success({ thinking: request.thinking });
    });
  }
  /**
   * 自拟 prompt 直发（`dev.prompt.probe`，EX-02）——prompt 编排的实验台。
   *
   * 为什么必须是 IPC 而不是一个脚本：真实密钥由 DPAPI 封存，**只有主进程内能解封**
   * （RH-17 红线）。把密钥导进环境变量或脚本就等于把封存作废，所以实验只能在这里做。
   *
   * 三条约束：
   * - **默认不存在**：没有 `LIGHTEE_DEV_PROBE=1` 就返回 invalid_request，与未注册命令无异。
   *   门控读的是**调用时刻**的环境变量而不是构造时快照——发布版进程里它永远是空的，
   *   而测试要能在同一进程里开关它。
   * - **不落 prompt**：留痕只记模型、耗时与计量。探针的输入正是最不该进日志的东西。
   * - 计量原样回传：实验的判据就是 token 与耗时，抹掉它等于没做实验。
   */
  async devPromptProbe(request: IpcRequestMap["dev.prompt.probe"]): Promise<AnyResult> {
    if (process.env.LIGHTEE_DEV_PROBE !== "1") {
      return failure(errorFor("invalid_request", "未知命令：dev.prompt.probe", false));
    }
    const llm = this.ctx.llm ?? this.engine?.createLlm() ?? null;
    if (!llm) return failure(errorFor("unsupported", "LLM wiring is unavailable", false));
    const model = request.model ?? (llm.listModels?.() ?? [])[0];
    if (!model) return failure(errorFor("not_found", "没有可用模型；请先在 AI 设置里配置", false));
    const startedAt = Date.now();
    try {
      // 给了 messages 就用完整多轮历史（PT-02 的第二轮）；否则退回单轮简写
      const messages = request.messages
        ? [{ role: "system", content: request.system }, ...request.messages]
        : [{ role: "system", content: request.system }, { role: "user", content: request.user }];
      const result = await llm.complete(model, messages, {
        ...(request.thinking ? { thinking: request.thinking } : {}),
        // maxTokens 此前在契约里声明、在这里被**静默丢弃**——与 resolveMaxTokens
        // 注释里记的那个「装饰性字段」是同一族缺陷。EX-10 的术语官那次调用
        // 因此没带输出预算跑的（脚本传了，这里没接）。
        ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
        // 工具（PT-02）：实验台本就是为「prompt 编排实验」建的，工具通道同属此列
        ...(request.tools ? { tools: request.tools } : {}),
        label: "probe",
      });
      const ms = Date.now() - startedAt;
      // C-1：只记数字。system/user/text 一个字都不进日志。工具名是代码常量，可记；
      // 工具**参数**含书内专名，与正文同级——不记。
      this.ctx.log("info", `dev prompt probe model=${model} ms=${ms} in=${result.usage?.input ?? 0} out=${result.usage?.output ?? 0} cacheRead=${result.usage?.cacheRead ?? 0} toolCalls=${result.toolCalls?.length ?? 0}`);
      return success({
        text: result.text,
        // 续接句柄（KA-1）：原样带出，本层不看内容。第二轮把它放回 messages[].continuation
        ...(result.continuation ? { continuation: result.continuation as never } : {}),
        ...(result.reasoning ? { reasoning: result.reasoning } : {}),
        ...(result.reasoningRedacted ? { reasoningRedacted: result.reasoningRedacted } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
        ...(result.stopReason ? { stopReason: result.stopReason } : {}),
        ...(result.rawStopReason ? { rawStopReason: result.rawStopReason } : {}),
        ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
        ms,
        attempts: result.attempts ?? 1,
        model,
      });
    } catch (cause) {
      this.ctx.log("warn", `dev prompt probe failed model=${model} ms=${Date.now() - startedAt}`);
      // 失败也要把已经付过钱的产出带出来（TR-02 同一纪律）：探针失败时，
      // 模型的工具参数与思考往往正是要看的东西——PT-02 首跑就栽在拿不到它们上。
      // details 只走实验台这条 dev 门控通道，不进日志、不进账本。
      const shape = cause as { toolCalls?: unknown; reasoning?: string; usage?: unknown; errorMessage?: string; shapeKind?: string; continuation?: unknown; diagnostics?: unknown } | null;
      const details = {
        ...(shape?.errorMessage ? { errorMessage: shape.errorMessage } : {}),
        // 形状分类与续接句柄（KA-1）：工具轮**本来就是**「没有正文」的那一类，
        // 运行时按失败上抛，可它恰恰是要接着往下走的那一轮——续接必须过得来。
        ...(shape?.shapeKind ? { shapeKind: shape.shapeKind } : {}),
        ...(shape?.continuation ? { continuation: shape.continuation } : {}),
        ...(shape?.toolCalls ? { toolCalls: shape.toolCalls } : {}),
        ...(shape?.usage ? { usage: shape.usage } : {}),
        ...(shape?.reasoning ? { reasoning: shape.reasoning } : {}),
        ...(shape?.diagnostics ? { diagnostics: shape.diagnostics } : {}),
      } as Parameters<typeof errorFor>[3];
      return failure(errorFor("internal", cause instanceof Error ? cause.message : "探针调用失败", true, details));
    }
  }

  /**
   * 逐档试探思考能力（`ai.thinking.probe`）。
   *
   * 为什么不能一次性用 `{thinking:"xhigh"}` 之类去试：pi-ai 的 `clampThinkingLevel`
   * 会把模型没写条目的档位**静默降级**，请求照样成功，于是「凡是没报错的都支持」。
   * 破法是每档一份**只放行一个档位**的临时配置（`probeLevelMap`），clamp 无从介入。
   *
   * 临时配置只存在于内存（`createLlm({ providers })`）。写进用户 models.json 再改回来
   * 是不能接受的：中途失败会把「全档位可用」这种没有依据的断言留在配置里。
   */
  async probeThinking(request: IpcRequestMap["ai.thinking.probe"]): Promise<AnyResult> {
    if (!this.engine) return failure(errorFor("unsupported", "Engine wiring is unavailable", false));
    const providers = await readLighteeModels();
    const provider = providers[request.providerId];
    const model = provider?.models?.find((candidate) => candidate.id === request.modelId);
    if (!provider || !model) {
      return failure(errorFor("not_found", `模型不存在：${request.providerId}/${request.modelId}`, false));
    }
    const modelRef = `${request.providerId}/${request.modelId}`;
    const outcomes: ProbeOutcome[] = [];
    for (const candidate of PROBE_CANDIDATES) {
      const llm = this.engine.createLlm({
        providers: {
          [request.providerId]: {
            name: provider.name,
            baseUrl: provider.baseUrl,
            api: provider.api,
            models: [{ id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens, thinkingLevelMap: probeLevelMap(candidate) }],
          },
        },
      });
      llm.label = "probe";
      try {
        const result = await llm.complete(modelRef, [
          { role: "system", content: "你是连接测试助手。只回复 OK。" },
          { role: "user", content: "ping" },
        ], { thinking: PROBE_REQUEST_LEVEL });
        // 「接受」与「真的回传了思考内容」分开记：很多服务商接受参数但不回传思考过程，
        // 据此判定不支持会误伤，所以 reasoned 只作展示，不参与 map 的构建。
        outcomes.push({ candidate, accepted: true, reasoned: Boolean(result.reasoning?.trim()) });
      } catch (error) {
        outcomes.push({ candidate, accepted: false, reasoned: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const thinkingLevelMap = buildThinkingLevelMap(outcomes);
    await mutateLighteeModels((current) => {
      const entry = current[request.providerId]?.models?.find((candidate) => candidate.id === request.modelId);
      // 探测期间模型被删掉了 → 不写（回调返回 null 表示不落盘）
      if (!entry) return { providers: null, result: undefined };
      entry.thinkingLevelMap = thinkingLevelMap;
      return { providers: current, result: undefined };
    });
    const usable = outcomes.filter((outcome) => outcome.accepted).length;
    this.emitAgentStatus("terminologist", "done", `思考能力探测完成：${modelRef}（${usable}/${outcomes.length} 档可用）`, { operation: "configuration" });
    return success({ providerId: request.providerId, modelId: request.modelId, thinkingLevelMap, outcomes });
  }

  async openAiKeyPage(request: IpcRequestMap["ai.key.open"]): Promise<AnyResult> {
    const preset = PRESET_PROVIDERS.find((candidate) => candidate.id === request.providerId);
    // 自定义服务商：打开其 baseUrl（通用登录页）
    const url = preset?.keyUrl ?? "";
    const opened = await this.openExternal(url || "https://www.google.com/search?q=" + encodeURIComponent(request.providerId + " api key"));
    return success({ opened, url });
  }
  async openAiConfig(request: IpcRequestMap["ai.config.open"]): Promise<AnyResult> {
    const path = request.kind === "auth" ? lighteeAuthPath() : lighteeModelsPath();
    const opened = await this.openConfigFile(request.kind);
    return success({ opened, path });
  }
  async detectAiModels(request: IpcRequestMap["ai.models.detect"]): Promise<AnyResult> {
    const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(request.baseUrl);
    let apiKey = request.apiKey ?? "";
    if (!apiKey && !isLocal) {
      // 自动使用已保存的密钥（auth.json）——保存后无需重新输入即可检测
      const auth = await readLighteeAuth();
      apiKey = authSecret(auth[request.providerId]) ?? "";
      if (!apiKey) return failure(errorFor("invalid_request", "检测模型需要 API Key：请先保存密钥（本地 Ollama 等除外）", false));
    }
    try {
      const url = request.baseUrl.replace(/\/$/, "") + "/models";
      const response = await fetch(url, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      });
      const text = await response.text();
      if (!response.ok) {
        return failure(errorFor("invalid_request", `模型检测失败：HTTP ${response.status}${text ? " — " + text.slice(0, 140) : ""}`, false));
      }
      let raw: Array<Record<string, unknown> & { id?: string }> = [];
      try {
        const json = JSON.parse(text) as { data?: Array<Record<string, unknown>>; models?: Array<Record<string, unknown>> };
        raw = json.data ?? json.models ?? [];
      } catch {
        // 非 JSON（如 HTML 错误页）→ 空
      }
      // 顺手读上下文窗口：有的服务商在 /models 里声明，有的完全不给。有就带上，没有就不猜。
      const models = raw.filter((m) => typeof m?.id === "string").map((m) => {
        const contextWindow = readContextLength(m);
        return { id: m.id as string, name: m.id as string, ...(contextWindow !== undefined ? { contextWindow } : {}) };
      });
      return success({ models, providerId: request.providerId });
    } catch (error) {
      return failure(errorFor("invalid_request", `模型检测失败：${error instanceof Error ? error.message : String(error)}`, false));
    }
  }

  /** config.json 原始内容 → 补全默认值后的 settings 视图（读写两侧共用，避免语义漂移） */
  private mergeSettings(raw: Record<string, JsonValue>): Record<string, JsonValue> {
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      translation: { ...(DEFAULT_SETTINGS.translation as Record<string, JsonValue>), ...(raw.translation as Record<string, JsonValue> | undefined) },
      editor: { ...(DEFAULT_SETTINGS.editor as Record<string, JsonValue>), ...(raw.editor as Record<string, JsonValue> | undefined) },
    };
  }

  async readSettings(request: IpcRequestMap["settings.read"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    const raw = await readJson<Record<string, JsonValue>>(join(workspace.root, "config.json"), {});
    return success({ values: this.mergeSettings(raw), revision: await this.readRevision(workspace.root, "settings") } satisfies SettingsSnapshot);
  }

  async writeSettings(request: IpcRequestMap["settings.write"]): Promise<AnyResult> {
    const workspace = this.workspace(request.workspaceId);
    if (!ALLOWED_SETTINGS.has(request.key)) return failure(errorFor("permission_denied", `Setting is not writable: ${request.key}`));
    // revision 检查与 RMW 必须在同一队列临界区内，且读到的必须是队列内的快照。
    return this.configMutation(workspace.root, async (raw, configPath) => {
      const current = await this.readRevision(workspace.root, "settings");
      if (current !== request.baseRevision) return failure(errorFor("conflict", `Settings revision is ${current}`, false, { currentRevision: current, baseRevision: request.baseRevision }));
      const next = structuredClone(this.mergeSettings(raw)) as Record<string, JsonValue>;
      const parts = request.key.split(".");
      let target = next;
      for (let index = 0; index < parts.length - 1; index += 1) {
        const part = parts[index]!;
        const existing = target[part];
        target[part] = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
        target = target[part] as Record<string, JsonValue>;
      }
      target[parts[parts.length - 1]!] = request.value;
      const revision = current + 1;
      await atomicWriteJson(configPath, next);
      await this.writeRevision(workspace.root, "settings", revision);
      // E5：翻译指南变更 → 全书 AI 基线失效（需重新全文审校）
      if (request.key === "translation.guide") await this.markBookReviewStale(workspace.root, "翻译指南变更");
      // 审校规则变更同理：规则注入通读窗口，改了规则旧报告就过时了
      if (request.key === "review.rules") await this.markBookReviewStale(workspace.root, "审校规则变更");
      return success({ revision, key: request.key });
    });
  }
}
