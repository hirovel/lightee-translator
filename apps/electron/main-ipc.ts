import { app, BrowserWindow, dialog, Notification, safeStorage, shell } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createIpcService, type EngineWiring } from "./shared/ipc-service.js";
import { AppLog } from "./shared/app-log.js";
import { lighteePaths } from "./shared/app-paths.js";
import { lighteeConfigDir, lighteeWorkspaceRegistryPath, migrateLighteeAuthEncryption, setSecretCodec } from "./shared/lightee-config.js";
import {
  importFile,
  previewImport,
  promotePendingTerms,
  translateChapterToFile,
  runChapterPipeline,
  recoverChapterPromotion,
  recoverChapterPromotionInTransaction,
  reviewChapter,
  runBookReview,
  loadSession as loadConfirmSession,
  saveSession as saveConfirmSession,
  verdict as confirmVerdict,
  finishSession as finishConfirmSession,
  exportChapter,
  LlmRuntime,
} from "@lightee/engine";

/**
 * 运维日志（RH-21 / C-1）。落在数据根的 logs 下——门禁与测试用隔离 profile，
 * 因此不会污染用户目录。**只写诊断摘要**，脱敏在 AppLog 内部无条件执行。
 */
export const appLog = new AppLog({ dir: lighteePaths(app.getPath("userData")).logsDir });

/**
 * 传给 engine 的两条路径。
 *
 * `LIGHTEE_CONFIG_DIR` 是隔离验收用来把配置指到临时目录的开关。它只覆盖 config，
 * 于是调用历史会照旧写进真实数据根——一次隔离运行反倒污染了用户的真实历史。
 * 所以这里跟着一起隔离：给了开关，历史就落在同一个临时目录里。
 */
const enginePaths = {
  configDir: lighteeConfigDir(),
  historyFile: process.env.LIGHTEE_CONFIG_DIR?.trim()
    ? join(lighteeConfigDir(), "llm-history.jsonl")
    : lighteePaths(app.getPath("userData")).historyFile,
};

process.on("uncaughtException", (error) => {
  void appLog.write("error", `uncaughtException: ${error?.stack ?? String(error)}`);
});
process.on("unhandledRejection", (reason) => {
  void appLog.write("error", `unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});

const fakeLlm = {
  complete: async (_model: string, messages: unknown[], opts?: { signal?: AbortSignal }) => {
    const typedMessages = messages.filter((message): message is { role: string; content: string } => Boolean(message) && typeof message === "object" && typeof (message as { role?: unknown }).role === "string" && typeof (message as { content?: unknown }).content === "string");
    const system = typedMessages.find((message) => message.role === "system")?.content ?? "";
    const user = typedMessages.find((message) => message.role === "user")?.content ?? "";
    if (system.includes("阅读轮")) return { text: JSON.stringify({ overview: "测试书籍", chapterDigests: {} }) };
    if (system.includes("人物与说话者归属分析器")) {
      const request = JSON.parse(user) as { blocks?: Array<{ id: string; kind: string; text: string }>; authorCharacters?: Array<{ id: string; canonicalName: string; aliases?: string[] }> };
      const blocks = request.blocks ?? [];
      const dialogue = blocks.filter((block) => block.kind === "dialogue");
      return { text: JSON.stringify({
        entities: [],
        attributions: [],
        unresolved: dialogue.length ? [{ blockIds: dialogue.map((block) => block.id), reason: "insufficient_context", evidenceBlockIds: dialogue.slice(0, 2).map((block) => block.id), explanation: "fake release fixture has no character attribution" }] : [],
      }) };
    }
    if (system.includes("角色语气画像分析器")) {
      const request = JSON.parse(user) as { entities?: Array<{ entityId: string }>; assignedAttributions?: Array<{ entityId: string; blockIds: string[]; evidenceBlockIds: string[] }> };
      return { text: JSON.stringify({ profiles: (request.assignedAttributions ?? []).map((attribution) => ({ entityId: attribution.entityId, selfRefs: [], particles: [], register: "plain", strategyZh: "fake release profile", evidenceBlockIds: attribution.evidenceBlockIds, explanation: "fake release profile" })) }) };
    }
    if (system.includes("全文审校者（窗口审校）")) return { text: JSON.stringify({ findings: [] }) };
    if (system.includes("全文审校汇总者")) return { text: JSON.stringify({ issues: [] }) };
    if (system.includes("术语复核官")) {
      const start = user.indexOf("[");
      const end = user.lastIndexOf("]");
      return { text: start >= 0 && end > start ? user.slice(start, end + 1) : "[]" };
    }
    if (system.includes("角色语气档案") || system.includes("拟声拟态词") || system.includes("梗侦探")) return { text: "[]" };
    if (system.includes("术语学家")) {
      const match = /[\u3040-\u30ff]{2,8}/.exec(user);
      return { text: match ? JSON.stringify([{ ja: match[0], zh: `译${match[0]}`, type: "term", keep: true, confidence: 0.95, rationale: "fake Terminologist result" }]) : "[]" };
    }
    if (process.env.LIGHTEE_FAKE_LLM_MODE === "stuck") return { text: "これは日本語のままです。" };
    // 门禁用：把翻译调用挂住直到取消信号到达，用来验证「⏹ 停止」这条路径（RH-16）
    if (process.env.LIGHTEE_FAKE_LLM_MODE === "hang") {
      const signal = opts?.signal;
      // 没有 signal 就挂起 = 不可杀死的进程；宁可立刻失败并说清楚原因。
      if (!signal) throw new Error("hang 模式需要取消信号，但调用方没有传 opts.signal");
      await new Promise<never>((_resolve, reject) => {
        if (signal.aborted) { reject(new Error("aborted")); return; }
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    const paragraphIds = [...user.matchAll(/<paragraph id=\"([^\"]+)\"/g)].map((match) => match[1]);
    if (paragraphIds.length > 0) return { text: paragraphIds.map((id) => `<paragraph id=\"${id}\">这是稳定的中文译文。</paragraph>`).join("\\n") };
    const termTranslations = [...system.matchAll(/- [^\n]+ → ([^\n]+)/g)].map((match) => match[1]?.trim()).filter((value): value is string => Boolean(value));
    return { text: `${termTranslations.length ? `${termTranslations.join(" ")} ${termTranslations.join(" ")} ` : ""}这是稳定的中文译文。` };
  },
  listModels: () => ["fake/release-gate"],
};

/**
 * 机密加密（RH-17 / A-4）：Windows = DPAPI（按当前操作系统账户绑定），macOS = Keychain，
 * Linux = libsecret（缺 keyring 时 isEncryptionAvailable() 为 false → 如实降级为明文）。
 * `available()` 每次实时求值——safeStorage 在 app ready 之前不可用。
 */
const safeStorageCodec = {
  available: () => {
    try { return app.isReady() && safeStorage.isEncryptionAvailable(); } catch { return false; }
  },
  encrypt: (plain: string) => safeStorage.encryptString(plain).toString("base64"),
  decrypt: (sealed: string) => safeStorageDecrypt(sealed),
};
function safeStorageDecrypt(sealed: string): string {
  const buffer = Buffer.from(sealed, "base64");
  // base64 解码不会失败，只会丢字符；空结果说明这不是我们写出的密文，必须显式报错，
  // 否则会把空串当成合法密钥用出去。
  if (buffer.length === 0) throw new Error("密文为空");
  return safeStorage.decryptString(buffer);
}
setSecretCodec(safeStorageCodec);

/** 引擎侧（LlmRuntime 同步读 auth.json）使用同一套解密逻辑 */
function decryptSecretForEngine(sealed: string): string {
  if (!safeStorageCodec.available()) throw new Error("加密后端不可用");
  return safeStorageDecrypt(sealed);
}

/** 明文旧条目的机会式加密迁移：app ready 后跑一次，失败不影响启动 */
void app.whenReady().then(async () => {
  try {
    const migrated = await migrateLighteeAuthEncryption();
    if (migrated > 0) console.log(`[lightee] auth.json：${migrated} 个明文密钥条目已加密`);
  } catch (error) {
    console.warn("[lightee] auth.json 加密迁移失败（保持明文，可用性不受影响）:", error);
  }
});

const engineWiring: EngineWiring = {
  importFile,
  previewImport,
  promotePendingTerms,
  translateChapterToFile,
  runChapterPipeline,
  recoverChapterPromotion,
  recoverChapterPromotionInTransaction,
  reviewChapter,
  runBookReview,
  confirm: {
    loadSession: loadConfirmSession,
    saveSession: saveConfirmSession,
    verdict: confirmVerdict,
    finishSession: finishConfirmSession,
  },
  exportChapter,
  createLlm: (options) => {
    if (process.env.LIGHTEE_FAKE_LLM === "1") return fakeLlm;
    // providers 传入时以内存配置构建（思考能力探测），此时不读磁盘 models.json；
    // 密钥仍走 auth.json + decryptSecret，与共享运行时同一条路径。
    //
    // configDir / historyFile **必须显式传**：engine 那边已经没有 `~/.lightee` 这类
    // 内置默认值了。路径是宿主的政策，库不替宿主选地方落盘。
    const runtime = LlmRuntime.create(options?.providers
      ? { ...enginePaths, providers: options.providers, decryptSecret: decryptSecretForEngine }
      : { ...enginePaths, decryptSecret: decryptSecretForEngine });
    return {
      complete: async (model, messages, opts) => {
        const started = Date.now();
        try {
          return await runtime.complete(model, messages as never, opts as never);
        } catch (error) {
          // C-1：只记模型、耗时、错误类型与消息——**绝不**记 prompt / response / key。
          // 完整调用详情仍然只在 Agent 控制台的内存环形缓冲里。
          const kind = error instanceof Error ? error.constructor.name : typeof error;
          const message = error instanceof Error ? error.message : String(error);
          void appLog.write("error", `llm failed model=${model} ms=${Date.now() - started} kind=${kind} message=${message}`);
          throw error;
        }
      },
      listModels: () => runtime.listModels(),
      // Agent 控制台：透传 LLM 调用日志（完整 prompt/response，环形缓冲）
      get label() { return runtime.label; },
      set label(value: string | undefined) { runtime.label = value; },
      getCallLog: (limit?: number) => runtime.getCallLog(limit),
      getCallLogById: (id: string) => runtime.getCallLogById(id),
      // 跨运行历史：内存缓冲重启即空，完整记录在 ~/.lightee/llm-history.jsonl 里
      getHistory: (limit?: number) => runtime.getHistory(limit),
      getTokenTotals: () => runtime.getTokenTotals(),
    };
  },
};

// 共享 LLM 运行时（真实模式）：日志跨调用累积，Agent 控制台可查询；fake 模式为 fakeLlm（无日志）
const sharedLlm = engineWiring.createLlm();

// 工作区书架：数据根的 config/workspaces.json（只存清单，译稿本体在用户自选目录里）。
// 从旧位置搬运由启动早期的 storage-migration 统一负责——路径迁移集中在一处，
// 免得又变成「每个模块各搬各的」。
const persistentRegistryPath = process.env.LIGHTEE_WORKSPACE_REGISTRY ?? lighteeWorkspaceRegistryPath();

export const ipcService = createIpcService({
  registryPath: persistentRegistryPath,
  isDev: !app.isPackaged,
  llm: sharedLlm as never,
  pickDirectory: async (title?: string) => {
    const result = await dialog.showOpenDialog({
      title: title ?? "选择工作区目录",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  },
  pickFile: async () => {
    const result = await dialog.showOpenDialog({
      title: "选择要导入的小说文件",
      properties: ["openFile"],
      filters: [{ name: "小说文件", extensions: ["epub", "txt", "md"] }],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  },
  openExternal: async (url: string) => { await shell.openExternal(url); return true; },
  // RS-1 / D13：跑批结束的系统通知。点击先拉起窗口，再回调服务层（发「通知被点击」
  // 事件，RS-2 据此把界面落到 Agent 控制台）。标题与正文只含数字摘要，不含书名正文。
  notify: (notice: { title: string; body: string; onClick?: () => void }) => {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title: notice.title, body: notice.body });
    notification.on("click", () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
      notice.onClick?.();
    });
    notification.show();
  },
  openConfigFile: async (kind: "models" | "auth") => {
    const { lighteeModelsPath, lighteeAuthPath } = await import("./shared/lightee-config.js");
    const target = kind === "auth" ? lighteeAuthPath() : lighteeModelsPath();
    try {
      const { existsSync } = await import("node:fs");
      if (!existsSync(target)) {
        const { writeFileSync, mkdirSync } = await import("node:fs");
        mkdirSync(target.replace(/[\/\\][^\/\\]*$/, ""), { recursive: true });
        writeFileSync(target, kind === "auth" ? "{}" : "{\n  \"providers\": {}\n}", "utf-8");
      }
      const { shell: electronShell } = await import("electron");
      const error = await electronShell.openPath(target);
      return !error;
    } catch {
      return false;
    }
  },
  engine: engineWiring,
  terminologyWatcher: true,
  log: (level, message) => { void appLog.write(level, message); },
  autoSnapshot: true,
});
