/**
 * RS 批验收（在 Electron 主进程内运行，由 LIGHTEE_HEADLESS_SCRIPT 加载）。
 *
 * ## 这份脚本要证明什么
 *
 * TP/RS 八票全部落地后，对真实模型的覆盖缺口恰好是三样，逐一取证：
 *
 * 1. **runScope 跑批引擎（RS-1）**：意图清单 → 串行逐章 → 结算单。
 *    证据：`translate.scopeChanged` 事件流完整（started → chapter-started →
 *    chapter-done → finished）、结算单不丢章（total = 各桶之和）。
 * 2. **登记即注入（ADR-0008 / TP-2）对真实模型生效**：
 *    证据：第 1 章开工前档案为空，第 2 章开工前档案 > 0（12 章实测的旧病是
 *    注入块 12 章全程「（无）」）；缓存读数据佐证 EX-05 前缀仍在。
 * 3. **终审改译触发真实追溯改名（TP-2/TP-3）**：
 *    证据：对跑批产出的一个 provenance=model 词条改译，renameRepair 如实报
 *    替换段数/章数/复核数，译文文件里旧译名清零。
 *
 * **只记数字、枚举与词条，不记正文**——正文完整落在临时工作区与 runs/ 导出，
 * 只留本地（runs/ 已 gitignore）。隔离面与其它真实跑批一致：只隔离
 * `LIGHTEE_WORKSPACE_REGISTRY`。
 *
 * 用法（由 run-scope-acceptance.mjs 拉起）：
 *   LIGHTEE_SCOPE_SOURCE=<epub/txt 路径> LIGHTEE_SCOPE_CHAPTERS=2
 */
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildUsageReport, renderUsageReport } from "../dist-main/shared/usage-report.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const envelope = (command, payload) => ({ version: 1, requestId: `${command}-scope-acceptance`, command, payload });

const transcript = [];
function say(line = "") { console.log(line); transcript.push(line); }

async function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

async function readJsonl(path) {
  const raw = await readFile(path, "utf8").catch(() => "");
  return raw.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export default async function run({ ipcService }) {
  const sourcePath = process.env.LIGHTEE_SCOPE_SOURCE;
  const limit = Math.max(1, Number(process.env.LIGHTEE_SCOPE_CHAPTERS ?? 2));
  if (!sourcePath || !existsSync(sourcePath)) { console.error(`源文件不存在：${sourcePath}`); return 1; }

  const startedAt = Date.now();
  const runId = `scope-acceptance-${startedAt}`;
  const workspaceRoot = await mkdtemp(join(tmpdir(), "lightee-scope-"));
  const invoke = async (command, payload) => ipcService.invoke(envelope(command, payload));

  /** 事件流全录（RS-1 的验收对象就是它） */
  const scopeEvents = [];
  /** 逐章开工前的档案计数（ADR-0008 注入增长的直接证据）——在事件回调里同步取样 */
  const archiveBefore = {};
  const warnings = [];
  const stop = ipcService.subscribe((event) => {
    if (event.type === "translate.scopeChanged") {
      const payload = { ...event.payload };
      scopeEvents.push({ at: Date.now() - startedAt, ...payload });
      if (payload.phase === "chapter-started" && payload.chapterId) {
        // 同步读档案计数：此刻 = 本章注入快照刚要定格的时刻
        archiveBefore[payload.chapterId] = {
          names: readJsonSync(join(workspaceRoot, "terminology", "names.json")),
          terms: readJsonSync(join(workspaceRoot, "terminology", "terms.json")),
        };
      }
    }
    if (event.type === "agent.status" && event.payload?.kind === "warning") {
      warnings.push({ at: Date.now() - startedAt, chapterId: event.payload.chapterId, message: event.payload.message });
    }
  });
  function readJsonSync(path) {
    try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).length : 0; } catch { return 0; }
  }

  const failures = [];
  const check = (ok, label) => {
    say(`${ok ? "✅" : "❌"} ${label}`);
    if (!ok) failures.push(label);
  };

  try {
    const created = await invoke("workspace.create", { path: workspaceRoot, name: "RS 批验收" });
    if (!created.ok) { console.error("workspace.create 失败", created.error); return 1; }
    const workspaceId = created.value.id;

    const providers = await invoke("ai.providers.list", { workspaceId });
    if (!providers.ok || !providers.value.providers.find((p) => p.id === providers.value.currentProvider)?.hasKey) {
      console.error("没有可用密钥"); return 1;
    }
    say("═══ RS 批验收（真实模型 · translate.runScope 全链路） ═══");
    say(`模型 ${providers.value.current} · 档位 ${providers.value.currentThinking}`);
    say("");

    const imported = await invoke("import.run", { workspaceId, sourcePath });
    if (!imported.ok) { console.error("import.run 失败", imported.error); return 1; }
    const opened = await invoke("workspace.open", { path: workspaceRoot });
    if (!opened.ok) { console.error("workspace.open 失败", opened.error); return 1; }
    const targets = opened.value.volumes.flatMap((v) => v.chapters).map((c) => c.id).slice(0, limit);
    say(`导入 ${imported.value.chapters} 章 · 本次跑批 ${targets.length} 章：${targets.join("、")}`);
    say("");

    // ===== 1. runScope 跑批 =====
    const t0 = Date.now();
    const result = await invoke("translate.runScope", { workspaceId, chapters: targets.map((chapterId) => ({ chapterId })) });
    const wallMs = Date.now() - t0;
    if (!result.ok) { console.error("translate.runScope 失败", result.error); return 1; }
    const summary = result.value;
    say(`── 跑批结束 · ${Math.round(wallMs / 1000)}s`);
    say(`   结算单：完成 ${summary.approved.length} · 待复核 ${summary.needsReview.length} · 卡住 ${summary.stuck.length} · 跳过 ${summary.skipped.length} · 失败 ${summary.failed.length} · 未跑 ${summary.remaining.length} · 停止 ${summary.stopped} · 待审术语 ${summary.pendingTerms}`);
    for (const w of warnings) say(`   ⚠ ${w.chapterId ?? ""} ${w.message}`);
    say("");

    say("═══ 验收断言 ═══");
    // RS-1：结算单不丢章
    const bucketSum = summary.approved.length + summary.needsReview.length + summary.stuck.length + summary.skipped.length + summary.failed.length + summary.remaining.length;
    check(bucketSum === summary.total && summary.total === targets.length, `结算单不丢章（total=${summary.total} = 各桶之和 ${bucketSum}）`);
    check(summary.approved.length === targets.length, `全部定稿（approved=${summary.approved.length}/${targets.length}）`);
    // RS-1：事件流完整
    const phases = scopeEvents.map((e) => e.phase);
    check(phases[0] === "started" && phases.at(-1) === "finished", `事件流首尾完整（${phases.join(" → ")}）`);
    check(scopeEvents.filter((e) => e.phase === "chapter-started").length === targets.length, "每章恰一条 chapter-started（忙碌卡 k/N 的数据源）");
    const indexes = scopeEvents.filter((e) => e.phase === "chapter-started").map((e) => e.index);
    check(JSON.stringify(indexes) === JSON.stringify(targets.map((_, i) => i + 1)), `k/N 序号严格递增（${indexes.join(",")}）`);
    // ADR-0008：注入随档案逐章增长（旧病：12 章全程「（无）」）
    const growth = targets.map((id) => `${id}: names ${archiveBefore[id]?.names ?? "?"} + terms ${archiveBefore[id]?.terms ?? "?"}`);
    say(`   逐章开工前档案计数：${growth.join(" ｜ ")}`);
    const second = archiveBefore[targets[1]];
    if (targets.length >= 2) {
      check((second?.names ?? 0) + (second?.terms ?? 0) > 0, "登记即注入对真实模型生效：第 2 章开工前档案 > 0");
    }
    // D13 数字与档案一致
    const names = await readJson(join(workspaceRoot, "terminology", "names.json"), []);
    const terms = await readJson(join(workspaceRoot, "terminology", "terms.json"), []);
    const provisional = [...names, ...terms].filter((t) => t.provenance === "model");
    say(`   档案终态：names ${names.length} · terms ${terms.length} · 其中暂定（provenance=model）${provisional.length}`);
    // 译文落盘（只看长度，不看内容）
    for (const id of summary.approved) {
      const text = await readFile(join(workspaceRoot, "translations", `${id}_zh.md`), "utf8").catch(() => "");
      check(text.length > 0, `${id} 译文落盘（${text.length} 字）`);
    }
    // 跑批结束后 stopScope 应是 idle（不是残留 run）
    const idle = await invoke("translate.stopScope", { workspaceId });
    check(idle.ok && idle.value.status === "idle", "跑批结束后 stopScope=idle（无残留 run 状态）");

    // ===== 2. 终审改译 → 真实追溯改名 =====
    //
    // 目标只从 terms.query 里取——渲染层的终审 UI 就是这个来源，往返同一套 id。
    // 教训（首轮验收）：档案文件的行 id 与 query 的展示 id **不是一套**（names
    // 档案的展示 id 带 `names:` 前缀，行 id 在 `sourceId`），跨源比对必然找不到；
    // 而且当时 if(item) 没有 else，一声不吭地跳过了整段——每个分支都必须出声。
    say("");
    const queried = await invoke("terms.query", { workspaceId });
    if (!queried.ok) {
      check(false, `终审改译实测无法进行：terms.query 失败（${queried.error?.code} ${queried.error?.message}）`);
    } else {
      const reviewables = queried.value.items.filter((i) => i.provenance === "model" && (i.archive === "names" || i.archive === "terms") && typeof i.zh === "string" && i.zh.length >= 2);
      // 选译文里真实出现最多的词条——renameRepair 报 0 的实测没有说服力
      let best = null;
      for (const item of reviewables) {
        let occurrences = 0;
        for (const id of summary.approved) {
          const text = await readFile(join(workspaceRoot, "translations", `${id}_zh.md`), "utf8").catch(() => "");
          occurrences += text.split(item.zh).length - 1;
        }
        if (occurrences > 0 && (!best || occurrences > best.occurrences)) best = { item, occurrences };
      }
      if (!best) {
        say(`── 终审改译实测跳过（如实报告）：${reviewables.length} 条暂定词条里没有在译文中出现过的`);
      } else {
        const { item, occurrences } = best;
        const newZh = `${item.zh}验`;
        say(`── 终审改译实测：「${item.ja} → ${item.zh}」（译文中 ${occurrences} 处）改为 「${newZh}」`);
        const updated = await invoke("terms.update", { workspaceId, termId: item.id, archive: item.archive, ja: item.ja, zh: newZh, ...(item.type ? { type: item.type } : {}), baseRevision: queried.value.revision });
        if (!updated.ok) {
          check(false, `terms.update 失败：${updated.error?.code} ${updated.error?.message}`);
        } else {
          const repair = updated.value.renameRepair;
          say(`   追溯结果：替换 ${repair?.replaced ?? 0} 段 / ${repair?.chapters ?? 0} 章 · ${repair?.queued ?? 0} 处进人工复核${repair?.blocked ? ` · blocked=${repair.blocked}` : ""}`);
          // 旧译名在译文文件里应清零（新译名包含旧译名，先剔除新译名再数）
          let residual = 0;
          for (const id of summary.approved) {
            const text = await readFile(join(workspaceRoot, "translations", `${id}_zh.md`), "utf8").catch(() => "");
            residual += text.split(newZh).join("").split(item.zh).length - 1;
          }
          check(residual === 0 || (repair?.queued ?? 0) >= residual, `追溯后旧译名残留 ${residual} 处（0 或不多于复核队列 ${repair?.queued ?? 0} 条）`);
          // provenance 翻 author（终审=定稿）。磁盘行 id 用 query 的 sourceId 对
          const after = await readJson(join(workspaceRoot, "terminology", item.archive === "names" ? "names.json" : "terms.json"), []);
          const flipped = after.find((t) => t.id === (item.sourceId ?? item.id));
          check(flipped?.provenance === "author" && flipped?.zh === newZh, "终审后 provenance=author 且新译法已入档");
        }
      }
    }

    // ===== 3. 用量与导出 =====
    say("");
    const ledger = await readJsonl(join(workspaceRoot, "sessions", "usage.jsonl"));
    say(renderUsageReport(buildUsageReport(ledger)));

    const outDir = join(repoRoot, "runs", runId);
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "scope-events.json"), JSON.stringify(scopeEvents, null, 2), "utf8");
    await writeFile(join(outDir, "summary.json"), JSON.stringify({ runId, model: providers.value.current, thinking: providers.value.currentThinking, wallMs, summary, archiveBefore, warnings, failures }, null, 2), "utf8");
    await writeFile(join(outDir, "acceptance.md"), `# RS 批验收（真实模型）\n\n\`\`\`\n${transcript.join("\n")}\n\`\`\`\n`, "utf8");
    say("");
    say(failures.length === 0 ? "✅ RS 批验收全部断言通过" : `❌ ${failures.length} 条断言失败：${failures.join("；")}`);
    console.log(`\n证据：${join(outDir, "summary.json")}`);
    console.log(`事件流：${join(outDir, "scope-events.json")}`);
    console.log(`工作区（含正文，只留本地）：${workspaceRoot}`);
    return failures.length === 0 ? 0 : 1;
  } finally {
    stop();
  }
}
