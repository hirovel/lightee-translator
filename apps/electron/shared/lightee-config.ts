/**
 * Lightee 独立配置（发布后不依赖 ~/.pi/agent）
 * 参考 pi agent 源码设计：
 *  - models.json 凭据无关（provider/模型定义，可共享）
 *  - auth.json 凭据分离（原子写 + 机密字段加密，见下方 SecretCodec）
 * 路径：~/.lightee/models.json + ~/.lightee/auth.json
 *
 * 本模块**不依赖 Electron**（测试与 CLI 可直接引入）。加密能力由宿主注入：
 * Electron 主进程在启动时 `setSecretCodec(...)` 注入 safeStorage（Windows = DPAPI）；
 * 未注入时全链路明文可用，行为与加密前一致。
 */
import { homedir } from "node:os";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileMutationQueue } from "./atomic-file.js";

export function lighteeConfigDir(): string {
  // LIGHTEE_CONFIG_DIR：测试与隔离验收运行指向临时目录，避免写入用户真实 ~/.lightee。
  // 生产运行不设置该变量。
  const override = process.env.LIGHTEE_CONFIG_DIR?.trim();
  return override ? override : join(homedir(), ".lightee");
}
export function lighteeModelsPath(): string {
  return join(lighteeConfigDir(), "models.json");
}
export function lighteeAuthPath(): string {
  return join(lighteeConfigDir(), "auth.json");
}

/**
 * 用户工作区书架。独立于 Electron profile，避免清理开发/浏览器缓存时丢失已注册工作区。
 */
export function lighteeWorkspaceRegistryPath(): string {
  return join(lighteeConfigDir(), "workspaces.json");
}

/** models.json 的 provider 配置形态（与 engine LlmRuntime.ProviderConfig 兼容） */
export interface ProviderOAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes?: string;
}
export interface LighteeProviderConfig {
  name?: string;
  baseUrl?: string;
  api?: "openai-responses" | "openai-completions";
  apiKey?: string;
  apiKeyEnv?: string;
  authKey?: string;
  authHeader?: boolean;
  /** 通用 OAuth 登录（浏览器授权流；登录后 token 作为 Bearer key 使用） */
  oauth?: ProviderOAuthConfig;
  models?: Array<{
    id: string;
    name?: string;
    api?: string;
    contextWindow?: number;
    maxTokens?: number;
    thinkingLevelMap?: Record<string, string | null>;
  }>;
}

export interface LighteeModelsFile {
  providers: Record<string, LighteeProviderConfig>;
  /**
   * 这份配置对过哪一版预置（见 PRESET_REVISION）。缺失 = 从未对账过的老配置。
   * 没有这个戳就只有两种糟糕选择：每次全量覆盖（抹掉用户手改）或永不更新
   * （停用的模型 id 一直留着）。
   */
  presetRevision?: number;
}

/** 原子写 JSON 文件（tmp + fsync + rename + directory fsync）+ 可选权限 */
async function atomicWriteJson(path: string, data: unknown, mode?: number): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    const handle = await open(tmp, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, path);
    let dirHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      dirHandle = await open(directory, "r");
      await dirHandle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !new Set(["EINVAL", "ENOTSUP", "EBADF", "EISDIR", "EPERM", "EACCES"]).has(code)) throw error;
    } finally {
      await dirHandle?.close().catch(() => undefined);
    }
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 读 Lightee models.json（不存在 → 空 providers） */
export async function readLighteeModels(): Promise<Record<string, LighteeProviderConfig>> {
  try {
    const raw = JSON.parse(await readFile(lighteeModelsPath(), "utf-8"));
    return (raw.providers ?? {}) as Record<string, LighteeProviderConfig>;
  } catch {
    return {};
  }
}

/** 读预置对账戳；缺失（老配置）返回 0 */
export async function readPresetRevision(): Promise<number> {
  try {
    const raw = JSON.parse(await readFile(lighteeModelsPath(), "utf-8")) as { presetRevision?: unknown };
    return typeof raw.presetRevision === "number" ? raw.presetRevision : 0;
  } catch {
    return 0;
  }
}

async function writeLighteeModelsUnlocked(providers: Record<string, LighteeProviderConfig>, presetRevision?: number): Promise<void> {
  // 不传就沿用磁盘上的戳——普通的 provider 增删改不该把对账记录抹掉
  const revision = presetRevision ?? await readPresetRevision();
  await atomicWriteJson(lighteeModelsPath(), { providers, presetRevision: revision } satisfies LighteeModelsFile);
}

/** 写 providers 的同时落对账戳（只有 reconcile 该用它） */
export async function writeLighteeModelsWithRevision(providers: Record<string, LighteeProviderConfig>, presetRevision: number): Promise<void> {
  await withFileMutationQueue(lighteeModelsPath(), () => writeLighteeModelsUnlocked(providers, presetRevision));
}

/** 写 Lightee models.json（原子 + 文件级写队列） */
export async function writeLighteeModels(providers: Record<string, LighteeProviderConfig>): Promise<void> {
  await withFileMutationQueue(lighteeModelsPath(), () => writeLighteeModelsUnlocked(providers));
}

/**
 * models.json 的唯一读-改-写临界区（ADR-0005 / design/write-authority.md）。
 * 回调在文件级写队列内执行：读、改、写之间不会与其他 mutate/write 交错。
 * 回调返回 null 表示不写。**不得在回调内再调用本模块的公开写函数**（同一队列会自锁）。
 */
export async function mutateLighteeModels<T>(
  fn: (providers: Record<string, LighteeProviderConfig>) => Promise<{ providers: Record<string, LighteeProviderConfig> | null; result: T }> | { providers: Record<string, LighteeProviderConfig> | null; result: T },
): Promise<T> {
  return withFileMutationQueue(lighteeModelsPath(), async () => {
    const providers = await readLighteeModels();
    const outcome = await fn(providers);
    if (outcome.providers) await writeLighteeModelsUnlocked(outcome.providers);
    return outcome.result;
  });
}

/** 添加/更新一个 provider 到 Lightee models.json（原子 upsert，整段在写队列内） */
export async function upsertLighteeProvider(providerId: string, config: LighteeProviderConfig): Promise<void> {
  await mutateLighteeModels((providers) => {
    providers[providerId] = { ...providers[providerId], ...config };
    return { providers, result: undefined };
  });
}

// ===== 机密编解码（RH-17 / 架构评估 A-4） =====

/**
 * 机密编解码器。宿主注入实现（Electron = safeStorage/DPAPI）；默认恒等（明文模式）。
 * `available()` 每次写入前实时求值——safeStorage 在 app ready 前不可用。
 */
export interface SecretCodec {
  available(): boolean;
  /** 明文 → 可存入 JSON 的密文串（实现自行选择编码，建议 base64） */
  encrypt(plain: string): string;
  /** 密文串 → 明文；无法解密时抛错 */
  decrypt(sealed: string): string;
}

/** auth.json 条目上的加密标记值；标记缺失 = 该条目的机密字段是明文 */
export const AUTH_SEALED_TAG = "dpapi-v1";
/** 条目中按机密处理的字段 */
const SECRET_FIELDS = ["key", "refreshToken"] as const;

const PLAIN_CODEC: SecretCodec = { available: () => false, encrypt: (value) => value, decrypt: (value) => value };
let secretCodec: SecretCodec = PLAIN_CODEC;

/** 注入机密编解码器；传 null 恢复明文模式（测试用） */
export function setSecretCodec(codec: SecretCodec | null): void {
  secretCodec = codec ?? PLAIN_CODEC;
}
/** 当前是否具备加密能力（供 UI/日志如实展示，不要用它推断磁盘上的实际状态） */
export function secretCodecAvailable(): boolean {
  try { return secretCodec.available(); } catch { return false; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 解封一个条目：
 *  - 无 `sealed` 标记 → 原样返回（明文条目）；
 *  - 有标记且解密成功 → 去掉标记、字段替换为明文；
 *  - 有标记但解密失败（编解码器不可用 / 密文被篡改 / 换了操作系统账户）→ **原样返回**。
 *    保留密文而不是丢弃，是为了不让一次读取毁掉用户可能还能恢复的密钥；
 *    调用方必须用 {@link authSecret} 取值——它会因标记仍在而返回 undefined（视为无密钥）。
 */
function unsealAuthEntry(providerId: string, entry: unknown): unknown {
  if (!isRecord(entry) || entry.sealed === undefined) return entry;
  if (entry.sealed !== AUTH_SEALED_TAG || !secretCodecAvailable()) {
    console.warn(`[lightee] auth.json 条目 ${providerId} 无法解密（标记 ${String(entry.sealed)}），已视为无密钥`);
    return entry;
  }
  const next: Record<string, unknown> = { ...entry };
  try {
    for (const field of SECRET_FIELDS) {
      const value = next[field];
      if (typeof value === "string" && value.length > 0) next[field] = secretCodec.decrypt(value);
    }
  } catch (error) {
    console.warn(`[lightee] auth.json 条目 ${providerId} 解密失败，已视为无密钥：${error instanceof Error ? error.message : String(error)}`);
    return entry;
  }
  delete next.sealed;
  return next;
}

/**
 * 加封一个条目。已带 `sealed` 标记的条目 = 上一步解封失败的密文，原样透传（绝不二次加密）。
 * 明文模式下原样写出（如实降级，不留假标记）。
 */
function sealAuthEntry(entry: unknown): unknown {
  if (!isRecord(entry) || entry.sealed !== undefined || !secretCodecAvailable()) return entry;
  const next: Record<string, unknown> = { ...entry };
  let sealedAny = false;
  for (const field of SECRET_FIELDS) {
    const value = next[field];
    if (typeof value !== "string" || value.length === 0) continue;
    next[field] = secretCodec.encrypt(value);
    sealedAny = true;
  }
  if (!sealedAny) return next;
  next.sealed = AUTH_SEALED_TAG;
  return next;
}

function mapAuth(auth: Record<string, unknown>, fn: (providerId: string, entry: unknown) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [providerId, entry] of Object.entries(auth)) out[providerId] = fn(providerId, entry);
  return out;
}

/**
 * 从 auth 条目取明文机密。**所有消费密钥的入口都必须经此函数**，不要直接读 `entry.key`：
 * 仍带 `sealed` 标记的条目意味着解密失败，其 `key` 是密文，直接使用会以「密钥错误」的形式失败。
 */
export function authSecret(entry: unknown, field: "key" | "refreshToken" = "key"): string | undefined {
  if (!isRecord(entry) || entry.sealed !== undefined) return undefined;
  const value = entry[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 读 auth.json 的磁盘原样内容（不解封）；仅供迁移与测试断言使用 */
export async function readLighteeAuthRaw(): Promise<Record<string, unknown>> {
  try {
    const raw: unknown = JSON.parse(await readFile(lighteeAuthPath(), "utf-8"));
    return isRecord(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** 读 Lightee auth.json（不存在 → 空）。返回**已解封**视图，机密字段为明文 */
export async function readLighteeAuth(): Promise<Record<string, unknown>> {
  return mapAuth(await readLighteeAuthRaw(), unsealAuthEntry);
}

async function writeLighteeAuthUnlocked(auth: Record<string, unknown>): Promise<void> {
  // 入参是明文视图；落盘前统一加封。0600 在 POSIX 上生效；Windows/NTFS 上 Node 的 chmod
  // 只切只读位、不改 ACL——机密性由 safeStorage 加密保证，不要依赖这个权限位。
  await atomicWriteJson(lighteeAuthPath(), mapAuth(auth, (_id, entry) => sealAuthEntry(entry)), 0o600);
}

/** 写 Lightee auth.json（原子 + 加封 + 文件级写队列，参考 pi FileAuthStorageBackend） */
export async function writeLighteeAuth(auth: Record<string, unknown>): Promise<void> {
  await withFileMutationQueue(lighteeAuthPath(), () => writeLighteeAuthUnlocked(auth));
}

/**
 * 机会式加密迁移：磁盘上仍是明文的条目，在编解码器可用时重写为密文。
 * 由宿主在注入 codec 后调用一次；无可迁移条目或明文模式下为空操作。
 * @returns 被加密的条目数
 */
export async function migrateLighteeAuthEncryption(): Promise<number> {
  if (!secretCodecAvailable()) return 0;
  return withFileMutationQueue(lighteeAuthPath(), async () => {
    const raw = await readLighteeAuthRaw();
    const plain = Object.values(raw).filter((entry) => isRecord(entry) && entry.sealed === undefined
      && SECRET_FIELDS.some((field) => typeof entry[field] === "string" && (entry[field] as string).length > 0));
    if (plain.length === 0) return 0;
    await writeLighteeAuthUnlocked(mapAuth(raw, unsealAuthEntry));
    return plain.length;
  });
}

/**
 * auth.json 的唯一读-改-写临界区。语义同 {@link mutateLighteeModels}。
 * 密钥写入丢失 = 用户以为已保存但实际未保存，必须整段互斥。
 */
export async function mutateLighteeAuth<T>(
  fn: (auth: Record<string, unknown>) => Promise<{ auth: Record<string, unknown> | null; result: T }> | { auth: Record<string, unknown> | null; result: T },
): Promise<T> {
  return withFileMutationQueue(lighteeAuthPath(), async () => {
    const auth = await readLighteeAuth();
    const outcome = await fn(auth);
    if (outcome.auth) await writeLighteeAuthUnlocked(outcome.auth);
    return outcome.result;
  });
}

// ===== 预置服务商模板（参考 pi 内置 provider；添加时一键填入，可自行修改） =====
export interface PresetModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, string | null>;
}
export interface PresetProvider {
  id: string;
  name: string;
  baseUrl: string;
  api: "openai-responses" | "openai-completions";
  /** 获取 API Key 页面（「获取 Key」按钮打开） */
  keyUrl?: string;
  models: PresetModel[];
  hint?: string;
}

/** 通用思考强度映射（pi thinkingLevelMap 格式：Lightee 档位 → 服务商档位） */
const TL_THINK: Record<string, string | null> = { off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max" };
const TL_NO_THINK: Record<string, string | null> = { off: "none" };
const TL_GPT: Record<string, string | null> = { off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };
/** Kimi K3：思考恒开（无 off 档），reasoning_effort 只有 low/high/max（官方 quickstart，2026-08） */
const TL_K3: Record<string, string | null> = { off: "low", minimal: "low", low: "low", medium: "low", high: "high", xhigh: "max", max: "max" };
/**
 * Gemini 3.7 Flash：官方文档只列 low / medium（默认）/ high 三档可调，没有关闭思考这一说。
 * 其余档位写 null（明确不可选）而不是留空——留空在运行时等于「原样透传」，
 * 那会把 `xhigh` 发给一个只认三档的服务商，换回一个报错。
 */
const TL_GEMINI: Record<string, string | null> = { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null };

/**
 * 预置服务商模板（MX-1 / D14，2026-08-13 全面查证）。
 *
 * 两条纪律：
 * 1. **只留各家现役最新代**——被官方停用的模型 ID（kimi-k2 系列、deepseek-chat 等）
 *    留在预置里就是给全新用户埋「模型不存在」的雷；
 * 2. **maxTokens 拉到官方规格上限，逐条留来源**（翻译任务需要长输出，设短只有损失；
 *    实测 output 16382~16385 撞 16384 上限全灭）。若 API 拒绝再按错误信息回落。
 *
 * 模型名随发布时间更新——保存后点 ⟳ 获取真实列表；此处是查证过的默认。
 */
/**
 * 曾经由本软件预置、后来撤下的服务商 id。
 *
 * 撤下预置只影响**新安装**——老用户的 `~/.lightee/models.json` 是首次启动时写死的一份
 * 快照，此后再没人碰过它，于是设置页里旧服务商与停用模型 id 原封不动地留着
 * （作者实测：「点击还都是落后的模型」）。`reconcilePresetProviders` 按这张表清理，
 * 但**配过密钥的一律不动**——那是用户做过的选择，不是我们的默认值。
 */
// google 已从撤下名单移除（2026-08-13）：Gemini 3.7 Flash 恢复为预置，见 PRESET_PROVIDERS。
// "gemini" 是更早一版用过的服务商 id，保留在撤下名单里，免得同一家在设置页里出现两条。
export const RETIRED_PRESET_PROVIDER_IDS: readonly string[] = ["zhipu", "gemini"];

/**
 * 预置版本戳。改动 PRESET_PROVIDERS 后 +1，老配置在下次启动时才会被对账一次。
 * 不带戳就无从判断「这份配置有没有对过账」，只能每次全量覆盖——那会抹掉用户的手改。
 */
export const PRESET_REVISION = 3;

export const PRESET_PROVIDERS: PresetProvider[] = [
  {
    id: "deepseek", name: "DeepSeek（深度求索）", baseUrl: "https://api.deepseek.com/v1", api: "openai-responses",
    keyUrl: "https://platform.deepseek.com/api_keys",
    models: [
      // v4 系列排在最前：项目默认模型就是 deepseek-v4-pro（config-service.resolveAgent /
      // workflow-service / engine DEFAULT_CONFIG 的回落值）。预置里没有它的话，全新安装的用户
      // 什么都没改就翻译会直接撞「模型不存在」——见 default-model.test.ts。
      // 规格来源：官方 Models & Pricing（api-docs.deepseek.com，2026-08 查证）：
      // 两个 v4 模型上下文 1M、最大输出 384K；Responses API 官方支持二者
      // （guides/responses_api，reasoning.effort 与 max_output_tokens 均为正式参数）。
      // deepseek-chat / deepseek-reasoner 已从官方 Pricing 页下架（2026-08 复查）——移除。
      { id: "deepseek-v4-pro", name: "deepseek-v4-pro", contextWindow: 1_048_576, maxTokens: 384_000 },
      { id: "deepseek-v4-flash", name: "deepseek-v4-flash", contextWindow: 1_048_576, maxTokens: 384_000 },
    ],
    hint: "https://platform.deepseek.com · 保存后点 ⟳ 获取真实模型",
  },
  {
    id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", api: "openai-responses",
    keyUrl: "https://platform.openai.com/api-keys",
    models: [
      // 规格来源：developers.openai.com/api/docs/models/gpt-5.6（2026-08 查证）：
      // gpt-5.6 别名路由到 GPT-5.6 Sol，上下文 1,050,000、最大输出 128,000。
      // 旧代 gpt-5 / gpt-5-mini 移除（官方已推荐 5.6；5.6 家族无 mini 变体）。
      { id: "gpt-5.6", name: "GPT-5.6", contextWindow: 1_050_000, maxTokens: 128_000, thinkingLevelMap: TL_GPT },
    ],
    hint: "https://platform.openai.com/api-keys · 保存后点 ⟳ 获取真实模型",
  },
  {
    // 官方平台已迁移：platform.moonshot.cn → platform.kimi.com，API 域名为 api.moonshot.ai
    // （规格来源：platform.kimi.ai/docs/guide/kimi-k3-quickstart，2026-08 查证）。
    id: "moonshot", name: "Moonshot（月之暗面 Kimi）", baseUrl: "https://api.moonshot.ai/v1", api: "openai-completions",
    keyUrl: "https://platform.kimi.com",
    models: [
      // kimi-latest 已于 2026-01-28、kimi-k2 系列已于 2026-05-25 官方停用——留着就是雷。
      // kimi-k3：上下文 1M；max_completion_tokens 默认 131,072、官方允许至 1,048,576
      // （输入+输出共享 1M 上下文，请求满额会被校验拒绝，故取默认档已远超整章需求）。
      // 思考恒开，reasoning_effort 支持 low/high/max。
      { id: "kimi-k3", name: "Kimi K3", contextWindow: 1_000_000, maxTokens: 131_072, thinkingLevelMap: TL_K3 },
    ],
    hint: "https://platform.kimi.com · 保存后点 ⟳ 获取真实模型",
  },
  // 智谱 GLM 的预置已按作者裁定移除（2026-08-13）：目标用户不会用到，
  // 而输出档位偏小的模型会触发长章截断这类软件问题（实测 output 撞上限即全灭）。
  // 需要时仍可经「添加服务商」手动配置——隐藏的是预置，不是能力。
  {
    // Google Gemini（2026-08-13 按官方文档恢复）。此前 Gemini 随 GLM 一起撤下，
    // 撤的理由是当时那代模型输出档位偏小；3.7 Flash 的 64k 输出足够整章翻译，理由不再成立。
    // 走 OpenAI 兼容端点，与其余预置同一条 openai-completions 路径。
    id: "google", name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", api: "openai-completions",
    keyUrl: "https://aistudio.google.com/apikey",
    models: [
      // 规格来源：ai.google.dev/gemini-api/docs/latest-model（2026-08-13 查证）：
      // 1M 上下文、64k 最大输出、思考档位三档 low/medium/high（medium 为默认）。
      // contextWindow 取 1_000_000：文档只写「1M」，不替它编一个更精确的数字——
      // 上下文估低是安全方向，估高会让长章在服务商侧被拒。
      { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash", contextWindow: 1_000_000, maxTokens: 65_536, thinkingLevelMap: TL_GEMINI },
    ],
    hint: "https://aistudio.google.com/apikey · 保存后点 ⟳ 获取真实模型",
  },
  {
    id: "qwen", name: "通义千问 Qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", api: "openai-completions",
    keyUrl: "https://dashscope.console.aliyun.com/apiKey",
    models: [
      // 规格来源：百炼 Model Studio 模型页 + 官方云端元数据（2026-08 查证）：
      // qwen3.8-max 上下文约 1M（983,616）、最大输出 131,072（思考模式）。
      // 旧别名 qwen-max / qwen-plus 指向的老代已淘汰，移除。
      { id: "qwen3.8-max", name: "Qwen3.8 Max", contextWindow: 983_616, maxTokens: 131_072, thinkingLevelMap: TL_THINK },
    ],
    hint: "https://dashscope.console.aliyun.com · 保存后点 ⟳ 获取真实模型",
  },
  {
    id: "siliconflow", name: "硅基流动 SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1", api: "openai-completions",
    keyUrl: "https://cloud.siliconflow.cn",
    models: [
      // ID 与上下文来源：siliconflow.cn/models（2026-08 查证；上下文标 1024K）。
      // 平台未公布单次输出上限——按上游 DeepSeek 官方规格 384K 拉满（D14：设短只有损失），
      // 若平台侧校验拒绝再按错误信息回落。
      { id: "deepseek-ai/DeepSeek-V4-Pro", name: "DeepSeek V4 Pro", contextWindow: 1_048_576, maxTokens: 384_000, thinkingLevelMap: TL_THINK },
      { id: "deepseek-ai/DeepSeek-V4-Flash", name: "DeepSeek V4 Flash", contextWindow: 1_048_576, maxTokens: 384_000, thinkingLevelMap: TL_THINK },
    ],
    hint: "https://cloud.siliconflow.cn · 保存后点 ⟳ 获取真实模型",
  },
  {
    id: "ollama", name: "Ollama（本地）", baseUrl: "http://localhost:11434/v1", api: "openai-completions",
    models: [
      // 本地模型没有「官方停用」语义，预置保留；输出上限取决于用户拉的具体模型与
      // 显存，8192 只是占位默认——长章翻译请按本地模型能力自行上调，否则会截断。
      { id: "qwen3", name: "Qwen3", contextWindow: 131072, maxTokens: 8192, thinkingLevelMap: TL_THINK },
      { id: "llama3.1", name: "Llama 3.1", contextWindow: 131072, maxTokens: 8192, thinkingLevelMap: TL_NO_THINK },
    ],
    hint: "本地模型，无需密钥 · 长章翻译请上调 maxTokens",
  },
];
