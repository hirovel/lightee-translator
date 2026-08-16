/**
 * 后端跑批验收（在 Electron 主进程内运行，由 LIGHTEE_HEADLESS_SCRIPT 加载）。
 *
 * 不开窗、不走 CDP、不碰渲染层——测后端就只测后端。密钥留在主进程内，一步不出去。
 *
 * 产出三份：
 *  - `docs/diagnostics/backend-run-<runId>.json`：结构化事实（逐章 + 报告聚合）
 *  - 终端上的诊断文本（`renderUsageReport`）——结论由系统给，不靠人现推
 *  - `runs/<runId>/`：**完整原文**（思考块全文、响应全文、逐条判定配原文与译文段落）
 *
 * 前两份只含数字、档位名与章节 ID，**不写标题、不写正文**——账本的意义之一就是
 * 「算钱和排障不必读进整本书」，这两份可以随手分享。
 *
 * 第三份是正文，只留本地（`runs/` 已进 .gitignore）。它存在的理由见
 * dump-run-artifacts.mjs 的注释：报告只给数字时，人要核对就只能听转述，
 * 而转述出过多次错。每跑一次就导一次，不依赖谁记得。
 *
 * 用法（由 npm run accept:backend 拉起）：
 *   LIGHTEE_ACCEPT_SOURCE=<epub 路径> LIGHTEE_ACCEPT_CHAPTERS=3
 */
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildUsageReport, renderUsageReport } from "../dist-main/shared/usage-report.js";
import { dumpRunArtifacts } from "./dump-run-artifacts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

const envelope = (command, payload) => ({ version: 1, requestId: `${command}-accept`, command, payload });

async function readLedger(root) {
  const raw = await readFile(join(root, "sessions", "usage.jsonl"), "utf8").catch(() => "");
  return raw.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export default async function run({ ipcService }) {
  const sourcePath = process.env.LIGHTEE_ACCEPT_SOURCE;
  const limit = Math.max(1, Number(process.env.LIGHTEE_ACCEPT_CHAPTERS ?? 3));
  if (!sourcePath) { console.error("缺少 LIGHTEE_ACCEPT_SOURCE"); return 1; }

  // 起始时刻同时当 runId 与历史筛选窗口的下界——两者必须是同一个数，
  // 否则导出会漏掉本轮最早那几次调用。
  const startedAt = Date.now();
  const runId = `run-${startedAt}`;
  const workspaceRoot = await mkdtemp(join(tmpdir(), "lightee-backend-"));
  const invoke = async (command, payload) => ipcService.invoke(envelope(command, payload));

  const created = await invoke("workspace.create", { path: workspaceRoot, name: "后端验收" });
  if (!created.ok) { console.error("workspace.create 失败", created.error); return 1; }
  const workspaceId = created.value.id;

  // 密钥与模型先探明，别翻到一半才发现——那时候钱已经花了一部分。
  const providers = await invoke("ai.providers.list", { workspaceId });
  if (!providers.ok) { console.error("ai.providers.list 失败", providers.error); return 1; }
  const current = providers.value.providers.find((p) => p.id === providers.value.currentProvider);
  if (!current?.hasKey) { console.error(`服务商 ${providers.value.currentProvider} 没有可用密钥`); return 1; }
  const meta = { runId, model: providers.value.current, provider: providers.value.currentProvider, thinking: providers.value.currentThinking };
  console.log(`模型 ${meta.model} · 服务商 ${meta.provider} · 请求档位 ${meta.thinking}`);

  const importStarted = Date.now();
  const imported = await invoke("import.run", { workspaceId, sourcePath });
  if (!imported.ok) { console.error("import.run 失败", imported.error); return 1; }
  console.log(`导入 ${imported.value.chapters} 章 · ${Date.now() - importStarted}ms`);

  const opened = await invoke("workspace.open", { path: workspaceRoot });
  if (!opened.ok) { console.error("workspace.open 失败", opened.error); return 1; }
  const targets = opened.value.volumes.flatMap((v) => v.chapters).map((c) => c.id).slice(0, limit);
  console.log(`本次翻 ${targets.length} 章\n`);

  const chapters = [];
  let seen = 0;
  for (const chapterId of targets) {
    const started = Date.now();
    const translated = await invoke("translate.run", { workspaceId, chapterId });
    const ms = Date.now() - started;
    const rows = await readLedger(workspaceRoot);
    const fresh = rows.slice(seen);
    seen = rows.length;
    const report = buildUsageReport(fresh);
    chapters.push({ chapterId, ms, ok: translated.ok, workflowStatus: translated.value?.workflowStatus ?? null, report });
    console.log(`── ${chapterId} · ${translated.ok ? translated.value.workflowStatus : "失败"} · ${Math.round(ms / 1000)}s`);
    console.log(renderUsageReport(report));
    console.log("");
  }

  const all = await readLedger(workspaceRoot);
  const overall = buildUsageReport(all);
  console.log("═══ 全程 ═══");
  console.log(renderUsageReport(overall));

  const outDir = join(repoRoot, "docs", "diagnostics");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `backend-${runId}.json`);
  await writeFile(outPath, JSON.stringify({ ...meta, importedChapters: imported.value.chapters, chapters, overall, ledger: all }, null, 2), "utf8");
  console.log(`\n报告（只有数字，可分享）：${outPath}`);

  // 完整原文导出。挂在出口上，跑一次就有一次——报告只给数字时，人要核对就只能听转述。
  // 导出失败不能让跑批失败：它是辅助设施，与账本写失败同一取舍。
  try {
    const raw = await dumpRunArtifacts({
      outDir: join(repoRoot, "runs", runId),
      workspaceRoot,
      since: startedAt,
      chapterIds: targets,
    });
    console.log(`完整原文（含正文，只留本地）：${raw.dir}`);
    console.log(`  ${raw.files.length} 个文件，从 00-索引.md 进`);
  } catch (error) {
    console.error("原文导出失败（跑批本身不受影响）：", error?.message ?? error);
  }
  return 0;
}
