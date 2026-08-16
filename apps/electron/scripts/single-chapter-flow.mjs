/**
 * 单章全流程实测（在 Electron 主进程内运行，由 LIGHTEE_HEADLESS_SCRIPT 加载）。
 *
 * 与 `backend-acceptance.mjs` 的分工：那份跑多章、给聚合账本，回答「花了多少钱」；
 * 这份只跑一章，回答的是**「这一章到底经过了哪些环节，每个环节的输入输出是什么」**。
 *
 * 为什么需要单独一份：删完术语族检查、Manager、盲替换之后，流程比从前短得多，
 * 但短在哪里、剩下的环节各自还在做什么，光看聚合数字看不出来。作者要的是能一眼
 * 读完的调用流水，而不是一份需要人现推的报表。
 *
 * 打印的是**时间轴**：每一条事件带 +ms 相对时刻，按发生顺序落在终端上——
 * 两轮工具通道的分界、L0 判定回灌、门禁、译后变换、审校、状态迁移各在哪一步，
 * 直接读得出来。
 *
 * 隔离面与 backend-acceptance 完全一致：只隔离 `LIGHTEE_WORKSPACE_REGISTRY`。
 * **不加** `--user-data-dir`、**不加** `LIGHTEE_CONFIG_DIR`——那会把真实
 * `~/.lightee` 一并隔离掉，于是拿不到 DPAPI 封存的密钥。密钥全程留在主进程内。
 *
 * 产出：
 *  - 终端：调用流水时间轴 + 逐环节输入输出摘要 + 账本
 *  - `runs/<runId>/`：**完整原文**（思考块全文、响应全文、逐条判定配原文与译文段落）
 *  - `runs/<runId>/flow.md`：终端流水的落盘副本（终端会滚掉，文件不会）
 *
 * 用法（由 run-single-chapter-flow.mjs 拉起）：
 *   LIGHTEE_FLOW_SOURCE=<txt/md/epub 路径>
 */
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildUsageReport, renderUsageReport } from "../dist-main/shared/usage-report.js";
import { dumpRunArtifacts } from "./dump-run-artifacts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

const envelope = (command, payload) => ({ version: 1, requestId: `${command}-flow`, command, payload });

/** 终端与文件同时收：终端会滚掉，跑一次几分钟的东西不能只留在滚动区里。 */
const transcript = [];
function say(line = "") {
  console.log(line);
  transcript.push(line);
}

async function readLedger(root) {
  const raw = await readFile(join(root, "sessions", "usage.jsonl"), "utf8").catch(() => "");
  return raw.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

/** 只报形状与长度，不报内容——正文另有 runs/ 的完整导出，这里是流水不是正文。 */
function shape(value) {
  if (value === undefined || value === null) return "—";
  if (typeof value === "string") return `${value.length} 字`;
  if (Array.isArray(value)) return `${value.length} 项`;
  return typeof value;
}

export default async function run({ ipcService }) {
  const sourcePath = process.env.LIGHTEE_FLOW_SOURCE;
  if (!sourcePath) { console.error("缺少 LIGHTEE_FLOW_SOURCE"); return 1; }
  if (!existsSync(sourcePath)) { console.error(`源文件不存在：${sourcePath}`); return 1; }

  const startedAt = Date.now();
  const runId = `flow-${startedAt}`;
  const workspaceRoot = await mkdtemp(join(tmpdir(), "lightee-flow-"));
  const invoke = async (command, payload) => ipcService.invoke(envelope(command, payload));

  // ===== 事件订阅：调用流水的主要来源 =====
  //
  // 翻译在锁外跑分钟级，中途只有事件能说明「现在在哪一步」。逐条带相对时刻落盘，
  // 两轮工具通道的分界因此可读——轮 1 的 agent.thinking 到 translate.progress
  // 之间那段就是 L0 判定回灌的位置。
  const events = [];
  const stop = ipcService.subscribe((event) => {
    events.push({ at: Date.now() - startedAt, type: event.type, payload: event.payload });
  });

  try {
    say("═══ 单章全流程实测 ═══");
    say("");

    // —— 环节 1：配置解析（密钥/模型/档位）——
    // 先探明再开工：翻到一半才发现没密钥，钱已经花了一部分。
    const created = await invoke("workspace.create", { path: workspaceRoot, name: "单章流程实测" });
    if (!created.ok) { console.error("workspace.create 失败", created.error); return 1; }
    const workspaceId = created.value.id;

    const providers = await invoke("ai.providers.list", { workspaceId });
    if (!providers.ok) { console.error("ai.providers.list 失败", providers.error); return 1; }
    const current = providers.value.providers.find((p) => p.id === providers.value.currentProvider);
    if (!current?.hasKey) { console.error(`服务商 ${providers.value.currentProvider} 没有可用密钥`); return 1; }

    say("【1】配置解析");
    say(`     服务商 ${providers.value.currentProvider} · 密钥 已封存可用（DPAPI，未出主进程）`);
    say(`     模型   ${providers.value.current}`);
    say(`     档位   ${providers.value.currentThinking}`);
    say("");

    // —— 环节 2：导入与分段 ——
    const imported = await invoke("import.run", { workspaceId, sourcePath });
    if (!imported.ok) { console.error("import.run 失败", imported.error); return 1; }
    const opened = await invoke("workspace.open", { path: workspaceRoot });
    if (!opened.ok) { console.error("workspace.open 失败", opened.error); return 1; }
    const chapterId = opened.value.volumes.flatMap((v) => v.chapters).map((c) => c.id)[0];
    if (!chapterId) { console.error("导入后没有章节"); return 1; }

    const loaded = await invoke("chapter.load", { workspaceId, chapterId });
    const sourceParas = loaded.ok ? (loaded.value.paragraphs ?? []) : [];
    const srcChars = sourceParas.reduce((n, p) => n + (p.source?.length ?? 0), 0);

    say("【2】导入与分段（L0，零 token）");
    say(`     源文件 ${sourcePath}`);
    say(`     导入   ${imported.value.chapters} 章，本次只翻 ${chapterId}`);
    say(`     分段   ${sourceParas.length} 段 · ${srcChars} 源字符`);
    say("");

    // —— 环节 3：翻译（工具通道两轮 + 门禁 + 译后变换 + 审校 + 状态迁移）——
    say("【3】翻译流水（事件时间轴，+ms 为相对起点）");
    say("");
    const translateStartedAt = Date.now();
    const eventsBefore = events.length;
    const translated = await invoke("translate.run", { workspaceId, chapterId });
    const ms = Date.now() - translateStartedAt;

    // `agent.thinking` 是**增量流**：一次调用能发出几十上百条。逐条打出来会把
    // 时间轴淹掉，而每一条单独看也没有信息量。所以按 `label + attempt` 攒成一个块，
    // 在收到 `done` 时以「起止时刻 + 累计字数 + 生效档位」的形式落一行——
    // 那正好就是工具通道两轮的天然分界：轮 1 的思考块收尾，紧接着就是 L0 判定回灌。
    const thinkingBlocks = new Map();
    const line = (at, type, detail) => say(`     +${String(at).padStart(6)}ms  ${type.padEnd(20)} ${detail}`);

    for (const e of events.slice(eventsBefore)) {
      const p = e.payload ?? {};
      if (e.type === "agent.text") {
        // 正文增量同样是流：按段攒成一格，只报到达节奏与字数，不把正文抄进流水
        const key = `text#${p.paragraphId ?? "?"}`;
        const block = thinkingBlocks.get(key) ?? { startedAt: e.at, chars: 0, thinking: "正文", chunks: 0 };
        block.chars += (p.delta ?? "").length;
        block.chunks += 1;
        thinkingBlocks.set(key, block);
        if (p.done) {
          line(e.at, "正文流", `${p.paragraphId ?? "?"} · ${block.chars} 字 · ${block.chunks} 批 · 历时 ${e.at - block.startedAt}ms`);
          thinkingBlocks.delete(key);
        }
        continue;
      }
      if (e.type === "agent.thinking") {
        const key = `${p.label ?? "?"}#${p.attempt ?? 1}`;
        const block = thinkingBlocks.get(key) ?? { startedAt: e.at, chars: 0, thinking: p.thinking, chunks: 0 };
        block.chars += (p.delta ?? "").length;
        block.chunks += 1;
        if (p.thinking) block.thinking = p.thinking;
        thinkingBlocks.set(key, block);
        if (p.done) {
          line(e.at, "思考块", `${p.label ?? "?"} 第${p.attempt ?? 1}次 · 档位 ${block.thinking ?? "?"} · 累计 ${block.chars} 字 · ${block.chunks} 批 · 历时 ${e.at - block.startedAt}ms`);
          thinkingBlocks.delete(key);
        }
        continue;
      }
      let detail;
      if (e.type === "agent.status") {
        detail = `${p.agent ?? "?"} · ${p.status ?? "?"}${p.kind === "warning" ? " · 【告警】" : ""}${p.message ? ` · ${p.message}` : ""}`;
      } else if (e.type === "translate.progress" || e.type === "review.progress") {
        detail = `${p.chapterId ?? ""} · ${Math.round((p.progress ?? 0) * 100)}%${p.message ? ` · ${p.message}` : ""}`;
      } else {
        detail = Object.entries(p)
          .filter(([k]) => k !== "workspaceId")
          .slice(0, 5)
          .map(([k, v]) => `${k}=${v && typeof v === "object" ? shape(v) : v}`)
          .join(" ");
      }
      line(e.at, e.type, detail);
    }
    // 收尾没到就说没到，不把未闭合的块假装成完成的
    for (const [key, block] of thinkingBlocks) {
      line(block.startedAt, "思考块", `${key} · 累计 ${block.chars} 字 · **没有收到 done**`);
    }
    say("");
    const textEvents = events.slice(eventsBefore).filter((e) => e.type === "agent.text");
    const textChars = textEvents.reduce((n, e) => n + ((e.payload?.delta ?? "").length), 0);
    say(`     正文流：${textEvents.length} 条事件 · ${textChars} 字 · 覆盖 ${new Set(textEvents.map((e) => e.payload?.paragraphId).filter(Boolean)).size} 段`);
    say("");
    say(`     翻译整体 ${translated.ok ? translated.value.workflowStatus : `失败：${translated.error?.message}`} · ${Math.round(ms / 1000)}s`);
    say("");

    // —— 环节 4：逐环节产物（读盘核对，不听转述）——
    const paragraphsPath = join(workspaceRoot, "state", "paragraphs", `${chapterId}.json`);
    const paraFile = existsSync(paragraphsPath) ? JSON.parse(await readFile(paragraphsPath, "utf8")) : null;
    const stagingPath = join(workspaceRoot, "state", "staging", `${chapterId}_zh.md`);
    const promotedPath = join(workspaceRoot, "translations", `${chapterId}_zh.md`);
    const translationPath = existsSync(promotedPath) ? promotedPath : stagingPath;
    const translation = existsSync(translationPath) ? await readFile(translationPath, "utf8") : "";

    const terminologyPath = join(workspaceRoot, "terminology");
    const readArchive = async (name) => {
      const path = join(terminologyPath, `${name}.json`);
      if (!existsSync(path)) return [];
      try { return JSON.parse(await readFile(path, "utf8")); } catch { return []; }
    };
    const names = await readArchive("names");
    const terms = await readArchive("terms");
    // 术语有**两条队列**，报错一条就会得出相反的结论：
    //   - `state/pending-terms.json`：入队缓冲。写进去的词会被抽干成卡片，抽完就空。
    //   - `state/cards.json`：确认队列本身，作者在界面上看到的就是它（ADR-0007）。
    // 第一次写这段流水时我只读了前者，读到 0，与事件里的「3 项待确认」对不上——
    // 那不是缺陷，是读错了出口。两条都报出来，谁也不会再被单独一个数字骗到。
    const readJsonArray = async (path) => {
      if (!existsSync(path)) return [];
      try { const v = JSON.parse(await readFile(path, "utf8")); return Array.isArray(v) ? v : []; } catch { return []; }
    };
    const pending = await readJsonArray(join(workspaceRoot, "state", "pending-terms.json"));
    const cards = await readJsonArray(join(workspaceRoot, "state", "cards.json"));

    say("【4】落盘产物");
    say(`     段落权威 ${paraFile ? `${paraFile.paragraphs?.length ?? 0} 段 · revision ${paraFile.revision ?? "?"}` : "缺失"}`);
    say(`     译文     ${translationPath === promotedPath ? "translations/（已定稿）" : "state/staging/（未定稿）"} · ${translation.length} 字`);
    say(`     术语档案 names ${names.length} · terms ${terms.length}（空是预期：确认后才进档案）`);
    say(`     入队缓冲 pending-terms.json ${pending.length} 条（抽干成卡片后归零，是正常状态）`);
    say(`     确认队列 cards.json ${cards.length} 条`);
    for (const card of cards) {
      const zh = card.candidates?.[0]?.zh ?? "?";
      say(`              ${card.ja} → ${zh}（${card.metadata?.source ?? "?"} · ${card.metadata?.termType ?? card.type ?? "?"}）`);
    }
    say("");

    // —— 环节 5：审校（零 LLM 调用，纯确定性扫描）——
    const reviewed = await invoke("review.run", { workspaceId, chapterId });
    say("【5】审校（CHK-02 之后零 LLM 调用）");
    if (!reviewed.ok) {
      say(`     失败：${reviewed.error?.message}`);
    } else if (reviewed.value.noTranslation) {
      say(`     没有可审校的译文`);
    } else {
      say(`     实际跑过的检查 ${reviewed.value.checksRun?.length ?? 0} 项：${(reviewed.value.checksRun ?? []).join("、")}`);
      say(`     问题 ${reviewed.value.issueCount ?? 0} 条`);
      for (const issue of reviewed.value.issues ?? []) {
        say(`       [${issue.severity}] ${issue.type} @ ${issue.paragraphId ?? issue.location} ${issue.found ? `— ${issue.found}` : ""}`);
      }
    }
    say("");

    // —— 环节 6：账本 ——
    const ledger = await readLedger(workspaceRoot);
    say("【6】账本（逐次网络尝试）");
    say(renderUsageReport(buildUsageReport(ledger)));
    say("");

    // —— 完整原文导出 ——
    // 导出失败不能让跑批失败：它是辅助设施，与账本写失败同一取舍。
    let dumpDir = null;
    try {
      const raw = await dumpRunArtifacts({
        outDir: join(repoRoot, "runs", runId),
        workspaceRoot,
        since: startedAt,
        chapterIds: [chapterId],
      });
      dumpDir = raw.dir;
      say(`完整原文（含正文，只留本地）：${raw.dir}`);
      say(`  ${raw.files.length} 个文件，从 00-索引.md 进`);
    } catch (error) {
      say(`原文导出失败（跑批本身不受影响）：${error?.message ?? error}`);
    }

    // 译文单独落一份平铺文本：QE-01 的对照脚本直接吃它，不必去翻工作区临时目录
    const outDir = dumpDir ?? join(repoRoot, "runs", runId);
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, `${chapterId}_zh.md`), translation, "utf8");
    await writeFile(join(outDir, "flow.md"), `# 单章全流程实测\n\n\`\`\`\n${transcript.join("\n")}\n\`\`\`\n`, "utf8");
    console.log(`\n流水副本：${join(outDir, "flow.md")}`);
    console.log(`译文平铺：${join(outDir, `${chapterId}_zh.md`)}`);
    return 0;
  } finally {
    stop();
  }
}
