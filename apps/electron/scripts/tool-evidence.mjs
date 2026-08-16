/**
 * 工具集判据取样（在 Electron 主进程内运行，由 LIGHTEE_HEADLESS_SCRIPT 加载）。
 *
 * ## 为什么单独一份
 *
 * `single-chapter-flow` 答「这一章经过了哪些环节」，`backend-acceptance` 答
 * 「花了多少钱」。定工具集要问的是第三件事：**模型在真实跑批里到底缺什么**。
 *
 * 四轮 SSR26 单章跑批得出的倾向是「工具集维持 1 个」，但那四轮全部来自同一章，
 * 而且门禁一次都没失败——`submit_translation` 要解决的问题在样本里根本没出现过。
 * 「没出现」可能是真的不需要，也可能只是这一章太简单。这份脚本就是去分开这两件事。
 *
 * ## 逐章记录的判据（每一条都对应一个待定工具）
 *
 * | 记录 | 回答哪个工具的存废 |
 * |---|---|
 * | 门禁失败次数与形态、重试预算消耗 | `submit_translation`（提议+否决）|
 * | 累积词表注入字符数的增长曲线 | `lookup_archive`（R2-1 注入量闸门）|
 * | `register_terms` 调用次数、登记数、被拒数与拒因 | 现有工具够不够用 |
 * | 是否走了分批、分批后是否更容易失败 | 会话粒度（一章一会话）|
 * | stuck 与审校问题 | 检查器是否还有假阳性 |
 *
 * **只记数字、枚举与词条，不记正文**——正文另有 `runs/` 的完整导出。
 *
 * 隔离面与其它跑批一致：只隔离 `LIGHTEE_WORKSPACE_REGISTRY`。
 *
 * 用法（由 run-tool-evidence.mjs 拉起）：
 *   LIGHTEE_EVIDENCE_SOURCE=<epub 路径> LIGHTEE_EVIDENCE_CHAPTERS=10
 */
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildUsageReport, renderUsageReport } from "../dist-main/shared/usage-report.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const envelope = (command, payload) => ({ version: 1, requestId: `${command}-evidence`, command, payload });

const transcript = [];
function say(line = "") { console.log(line); transcript.push(line); }

async function readJsonl(path, since) {
  const raw = await readFile(path, "utf8").catch(() => "");
  return raw.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const row = JSON.parse(line);
      return since === undefined || (row.ts ?? row.at ?? 0) >= since ? [row] : [];
    } catch { return []; }
  });
}

async function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

export default async function run({ ipcService }) {
  const sourcePath = process.env.LIGHTEE_EVIDENCE_SOURCE;
  const limit = Math.max(1, Number(process.env.LIGHTEE_EVIDENCE_CHAPTERS ?? 10));
  if (!sourcePath || !existsSync(sourcePath)) { console.error(`源文件不存在：${sourcePath}`); return 1; }

  const startedAt = Date.now();
  const runId = `evidence-${startedAt}`;
  const workspaceRoot = await mkdtemp(join(tmpdir(), "lightee-evidence-"));
  const invoke = async (command, payload) => ipcService.invoke(envelope(command, payload));
  const historyPath = join(homedir(), ".lightee", "llm-history.jsonl");

  // 告警是门禁失败与提取哑火的**唯一**外传通道（onTranslateWarn → agent.status kind=warning）
  const warnings = [];
  const stop = ipcService.subscribe((event) => {
    if (event.type === "agent.status" && event.payload?.kind === "warning") {
      warnings.push({ at: Date.now() - startedAt, chapterId: event.payload.chapterId, message: event.payload.message });
    }
  });

  try {
    const created = await invoke("workspace.create", { path: workspaceRoot, name: "工具判据取样" });
    if (!created.ok) { console.error("workspace.create 失败", created.error); return 1; }
    const workspaceId = created.value.id;

    const providers = await invoke("ai.providers.list", { workspaceId });
    if (!providers.ok || !providers.value.providers.find((p) => p.id === providers.value.currentProvider)?.hasKey) {
      console.error("没有可用密钥"); return 1;
    }
    say("═══ 工具集判据取样 ═══");
    say(`模型 ${providers.value.current} · 档位 ${providers.value.currentThinking}`);
    say("");

    const imported = await invoke("import.run", { workspaceId, sourcePath });
    if (!imported.ok) { console.error("import.run 失败", imported.error); return 1; }
    const opened = await invoke("workspace.open", { path: workspaceRoot });
    if (!opened.ok) { console.error("workspace.open 失败", opened.error); return 1; }
    const targets = opened.value.volumes.flatMap((v) => v.chapters).map((c) => c.id).slice(0, limit);
    say(`导入 ${imported.value.chapters} 章，本次翻前 ${targets.length} 章（按阅读顺序——累积词表的增长依赖它）`);
    say("");

    const rows = [];
    let ledgerSeen = 0;
    let historySeen = (await readJsonl(historyPath)).length;

    for (const chapterId of targets) {
      const warnBefore = warnings.length;
      const t0 = Date.now();
      const before = {
        // 注入量闸门（R2-1）：确认过的词才会进注入块，所以这里读档案而不是卡片
        names: (await readJson(join(workspaceRoot, "terminology", "names.json"), [])).length,
        terms: (await readJson(join(workspaceRoot, "terminology", "terms.json"), [])).length,
      };
      const loaded = await invoke("chapter.load", { workspaceId, chapterId });
      const srcChars = (loaded.ok ? loaded.value.paragraphs ?? [] : []).reduce((n, p) => n + (p.source?.length ?? 0), 0);
      const srcParas = (loaded.ok ? loaded.value.paragraphs ?? [] : []).length;

      const translated = await invoke("translate.run", { workspaceId, chapterId });
      const ms = Date.now() - t0;

      const ledger = await readJsonl(join(workspaceRoot, "sessions", "usage.jsonl"));
      const fresh = ledger.slice(ledgerSeen);
      ledgerSeen = ledger.length;
      const report = buildUsageReport(fresh);

      // 本章的网络尝试：`toolCalls` 现在落盘了，登记行为可以直接数，不必推断
      const history = await readJsonl(historyPath);
      const attempts = history.slice(historySeen).filter((r) => String(r.label ?? "").endsWith(`:${chapterId}`));
      historySeen = history.length;
      const registerCalls = attempts.flatMap((r) => (Array.isArray(r.toolCalls) ? r.toolCalls : []))
        .filter((c) => c?.name === "register_terms");
      const registeredTerms = registerCalls.flatMap((c) => c.arguments?.terms ?? []);
      const registeredVoices = registerCalls.flatMap((c) => c.arguments?.voices ?? []);

      const cards = await readJson(join(workspaceRoot, "state", "cards.json"), []);
      const chapterWarnings = warnings.slice(warnBefore);
      const reviewed = await invoke("review.run", { workspaceId, chapterId });

      rows.push({
        chapterId,
        srcChars, srcParas,
        state: translated.ok ? translated.value.workflowStatus : "失败",
        ...(translated.ok ? {} : { error: translated.error?.message }),
        ms,
        attempts: report.attempts, wasted: report.wastedAttempts,
        wastedByKind: report.wastedByKind,
        // 分批的判据：一章多于两次网络尝试且没有废尝试 = 走了分批（每批各两轮）
        batched: report.attempts > 2 && report.wastedAttempts === 0,
        registerCalls: registerCalls.length,
        registeredTerms: registeredTerms.length,
        registeredVoices: registeredVoices.length,
        termsSample: registeredTerms.map((t) => `${t.ja}→${t.zh}(${t.type})`),
        glossaryBefore: before,
        cardsTotal: cards.length,
        warnings: chapterWarnings.map((w) => w.message),
        review: reviewed.ok
          ? { issues: reviewed.value.issueCount ?? 0, types: (reviewed.value.issues ?? []).map((i) => `${i.severity}:${i.type}`) }
          : { error: reviewed.error?.message },
        input: report.input, output: report.output, cacheRead: report.cacheRead,
      });

      const r = rows.at(-1);
      say(`── ${chapterId} · ${r.state} · ${Math.round(ms / 1000)}s · ${srcChars} 字 / ${srcParas} 段`);
      say(`   尝试 ${r.attempts}（废 ${r.wasted}）${r.batched ? " · 走了分批" : ""} · 登记 ${r.registerCalls} 次 / ${r.registeredTerms} 词 / ${r.registeredVoices} 卡 · 卡片累计 ${r.cardsTotal}`);
      if (r.warnings.length) for (const w of r.warnings) say(`   ⚠ ${w}`);
      if (r.review.issues) say(`   审校 ${r.review.issues} 条：${r.review.types.join("、")}`);
      say("");
    }

    // ===== 汇总：直接对着工具的存废问 =====
    const total = rows.length;
    const gateFailures = rows.reduce((n, r) => n + r.wasted, 0);
    const stuck = rows.filter((r) => r.state === "stuck");
    const batched = rows.filter((r) => r.batched);
    const dumb = rows.filter((r) => r.registerCalls === 0 && r.srcChars >= 800);
    const allIssues = rows.flatMap((r) => r.review.types ?? []);

    say("═══ 判据汇总 ═══");
    say("");
    say(`章节 ${total} · 定稿 ${rows.filter((r) => r.state === "approved").length} · stuck ${stuck.length}`);
    say(`门禁/重试废掉的尝试：${gateFailures} 次${gateFailures === 0 ? "（submit_translation 想解决的问题没有出现）" : ""}`);
    if (gateFailures > 0) {
      const kinds = {};
      for (const r of rows) for (const [k, v] of Object.entries(r.wastedByKind ?? {})) kinds[k] = (kinds[k] ?? 0) + v;
      say(`  形态：${Object.entries(kinds).map(([k, v]) => `${k}×${v}`).join(" · ")}`);
    }
    say(`走了分批的章：${batched.length}${batched.length ? `（${batched.map((r) => r.chapterId).join("、")}）` : ""}`);
    say(`一次都没调 register_terms 的长章（哑火）：${dumb.length}${dumb.length ? `（${dumb.map((r) => r.chapterId).join("、")}）` : ""}`);
    say(`卡片累计：${rows.at(-1)?.cardsTotal ?? 0} 条 —— lookup_archive 的闸门看的是**确认后**的注入量，卡片未确认则注入仍为空`);
    const issueCount = {};
    for (const t of allIssues) issueCount[t] = (issueCount[t] ?? 0) + 1;
    say(`审校问题合计 ${allIssues.length}${allIssues.length ? `：${Object.entries(issueCount).map(([k, v]) => `${k}×${v}`).join(" · ")}` : "（检查器零命中）"}`);
    say("");
    say(renderUsageReport(buildUsageReport(await readJsonl(join(workspaceRoot, "sessions", "usage.jsonl")))));

    const outDir = join(repoRoot, "runs", runId);
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "evidence.json"), JSON.stringify({ runId, model: providers.value.current, thinking: providers.value.currentThinking, rows }, null, 2), "utf8");
    await writeFile(join(outDir, "evidence.md"), `# 工具集判据取样\n\n\`\`\`\n${transcript.join("\n")}\n\`\`\`\n`, "utf8");
    console.log(`\n判据：${join(outDir, "evidence.json")}`);
    console.log(`流水：${join(outDir, "evidence.md")}`);
    console.log(`工作区（含正文，只留本地）：${workspaceRoot}`);
    return 0;
  } finally {
    stop();
  }
}
