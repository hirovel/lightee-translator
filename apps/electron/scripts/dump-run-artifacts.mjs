/**
 * 跑批原始导出：把这一轮的**完整原文**写成可直接打开的文件。
 *
 * ## 为什么这是系统的性质，不是「记得做」
 *
 * 2026-08-12 的诊断反复栽在同一件事上：报告只给数字，人要核对就得让我去刨
 * 30 MB 的 llm-history.jsonl，于是「我的推断」成了唯一入口——而那些推断
 * 出过多次错（把没记录的字段当成模型行为、把自己设的天花板栽给服务商、
 * 把 9/17 条误报当成真实质量问题）。作者明确要求：**每次跑批都要有完整输出
 * 可以自己看，禁止只给推断。**
 *
 * 所以导出挂在跑批出口上，跑一次就有一次，不依赖谁记得。
 *
 * ## 红线
 *
 * 这里写的是**正文**（原文与译文、思考块全文），因此：
 * - 落在仓库根的 `runs/`，已进 .gitignore——版权正文与工作区数据不入库；
 * - 与 `docs/diagnostics/backend-run-*.json` 分家，那份仍然只有数字，可以随手分享；
 * - 账本 `usage.jsonl` 的白名单不受影响，仍然只记 reasoningChars 长度。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const fence = (text) => ["```", text || "（空）", "```"].join("\n");

/** 读这一轮时间窗内的调用历史（逐次网络尝试一条，TR-02 之后失败尝试也在内） */
async function readHistory(since) {
  const path = join(homedir(), ".lightee", "llm-history.jsonl");
  const raw = await readFile(path, "utf8").catch(() => "");
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if ((entry.ts ?? 0) >= since) rows.push(entry);
    } catch { /* 坏行跳过 */ }
  }
  return { path, rows };
}

async function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

/**
 * 导出一轮跑批的全部原文。
 *
 * @param {object} input
 * @param {string} input.outDir      导出目录（`runs/<runId>`）
 * @param {string} input.workspaceRoot 工作区根（读段落存档与审校报告）
 * @param {number} input.since       本轮起始时间戳（筛历史）
 * @param {string[]} input.chapterIds 本轮翻的章节
 * @returns {Promise<{dir: string, files: string[]}>}
 */
export async function dumpRunArtifacts({ outDir, workspaceRoot, since, chapterIds }) {
  await mkdir(outDir, { recursive: true });
  const files = [];
  const index = [];

  // ── 1. 逐次网络尝试：思考块全文 + 响应全文
  const { path: historyPath, rows } = await readHistory(since);
  index.push("## 逐次网络尝试（思考块全文 + 响应全文）", "", `来源：\`${historyPath}\``, "");
  for (const [i, r] of rows.entries()) {
    const label = String(r.label ?? "x").replace(/[:\\/]/g, "_");
    const name = `attempt-${String(i + 1).padStart(2, "0")}-${label}-第${r.attempt ?? 1}次-${r.thinking ?? "na"}-${r.ok ? "成功" : "失败"}.md`;
    const reasoning = r.reasoning ?? "";
    const response = r.response ?? "";
    // 工具通道的轮 1 **只发工具调用、没有正文**：`response` 长度 0，而它才是这一轮
    // 全部的产出。不导出的话，最贵的那一轮（实测 262 秒、12270 推理 token）在原始
    // 记录里是一片空白，核对只能靠反推——那正是这份导出存在的理由要杜绝的事。
    const toolCalls = Array.isArray(r.toolCalls) ? r.toolCalls : [];
    // 发出去的那一份也要在。少了它，「模型为什么这么答」永远只能靠猜——
    // 而 prompt 里两条规则互相拉扯这种事，不看原文根本看不出来。
    const messages = Array.isArray(r.messages) ? r.messages : [];
    const promptBlocks = messages.length > 0
      ? messages.flatMap((m) => [`### role: ${m.role}（${(m.content ?? "").length} 字符）`, "", fence(m.content), ""])
      : ["### 拼接后的完整 prompt", "", fence(r.prompt), ""];
    await writeFile(join(outDir, name), [
      `# ${r.label ?? "?"} · 第 ${r.attempt ?? 1} 次尝试 · 档位 ${r.thinking ?? "-"}`,
      "",
      `- 结果：${r.ok ? "成功" : `失败${r.error ? `（${r.error}）` : ""}`}`,
      `- 耗时：${Math.round((r.ms ?? 0) / 1000)} 秒`,
      `- usage：${JSON.stringify(r.usage ?? {})}`,
      `- 输入 ${(r.prompt ?? "").length} 字符 · 思考 ${reasoning.length} 字符 · 响应正文 ${response.length} 字符 · 工具调用 ${toolCalls.length} 次`,
      "",
      "## 发出去的 prompt（未加工）",
      "",
      ...promptBlocks,
      // KA-5 之后术语登记的指令**一个字都不在 prompt 里**：判据在工具 description、
      // 形状由 schema 保证。只导 messages 的话，读的人会以为我们什么都没告诉模型。
      "## 发出去的工具定义（未加工）",
      "",
      Array.isArray(r.tools) && r.tools.length > 0
        ? r.tools.map((t) => [`### ${t.name}`, "", "description：", "", fence(t.description ?? ""), "", "parameters（JSON Schema）：", "", fence(JSON.stringify(t.parameters ?? {}, null, 1))].join("\n")).join("\n\n")
        : "（本次调用没有带工具）",
      "",
      "## 思考块原文（未加工）",
      "",
      fence(reasoning),
      "",
      "## 模型发起的工具调用（参数未加工）",
      "",
      toolCalls.length > 0
        ? toolCalls.map((c) => [`### ${c.name}（id ${c.id}）`, "", fence(JSON.stringify(c.arguments, null, 1))].join("\n")).join("\n\n")
        : "（本次尝试没有工具调用）",
      "",
      "## 响应正文原文（未加工）",
      "",
      fence(response),
      "",
    ].join("\n"), "utf8");
    files.push(name);
    index.push(`- [${name}](${encodeURI(name)}) — ${r.ok ? "成功" : "失败"} · ${r.thinking ?? "-"} · 思考 ${reasoning.length} · 正文 ${response.length} · 工具调用 ${toolCalls.length}`);
  }
  index.push("");

  // ── 2. 逐章判定：每条 issue 配上它所指的原文段落与译文段落
  index.push("## 逐章检查判定（每条配原文段落与译文段落）", "");
  for (const chapterId of chapterIds) {
    const review = await readJson(join(workspaceRoot, "reviews", `${chapterId}.current.json`));
    const store = await readJson(join(workspaceRoot, "state", "paragraphs", `${chapterId}.json`));
    const byId = new Map((store?.paragraphs ?? []).map((p) => [p.id, p]));
    const issues = review?.issues ?? [];
    const name = `checks-${chapterId}.md`;
    const body = [
      `# ${chapterId} · 检查判定逐条摊开`,
      "",
      `报告：\`reviews/${chapterId}.current.json\`（${issues.length} 条） · 段落：\`state/paragraphs/${chapterId}.json\`（${byId.size} 段）`,
      "",
      "**判定真假以下面的正文为准。**",
      "",
    ];
    for (const [i, issue] of issues.entries()) {
      const id = issue.paragraphId ?? (issue.paragraphIds ?? [])[0] ?? "?";
      const p = byId.get(id) ?? {};
      body.push(
        "---",
        "",
        `## ${i + 1}. \`${issue.type}\` · ${issue.severity ?? "-"} · ${id}`,
        "",
        `检查报告：${issue.found ?? "(无)"}`,
        "",
        "**原文**",
        "",
        fence(p.source),
        "",
        "**译文**",
        "",
        fence(p.translation),
        "",
      );
    }
    if (issues.length === 0) body.push("（本章没有判定条目）", "");
    await writeFile(join(outDir, name), body.join("\n"), "utf8");
    files.push(name);
    index.push(`- [${name}](${encodeURI(name)}) — ${issues.length} 条判定 · ${byId.size} 段`);
  }
  index.push("");

  // ── 3. 全章译文原文（不经任何摘录）
  index.push("## 全章译文", "");
  for (const chapterId of chapterIds) {
    const store = await readJson(join(workspaceRoot, "state", "paragraphs", `${chapterId}.json`));
    const paras = store?.paragraphs ?? [];
    const name = `translation-${chapterId}.md`;
    await writeFile(join(outDir, name), [
      `# ${chapterId} · 逐段原文 / 译文对照（${paras.length} 段）`,
      "",
      ...paras.flatMap((p) => [`## ${p.id}`, "", "**原文**", "", fence(p.source), "", "**译文**", "", fence(p.translation), ""]),
    ].join("\n"), "utf8");
    files.push(name);
    index.push(`- [${name}](${encodeURI(name)}) — ${paras.length} 段对照`);
  }

  // ── 4. 术语提取流程（EX-04 融合提取 → KA-4/KA-5 工具通道）：从模型登记的参数一路到候选卡片
  //
  // 这一段原来是去响应正文里找 `===TERMS===` 尾块。KA-5 把围栏通道整个删掉之后，
  // 那段代码恒定输出「本章响应里没有 ===TERMS=== 尾块」，跨章一致性表恒定输出
  // 「共出现 0 个原文词、0 个分歧」——**一个看起来像结论的假数据**，比单纯的死代码更坏：
  // 死代码只是不跑，它是在回答一个没人问它的问题，而且答错。
  // 现在读的是历史里的工具调用参数，那才是模型真正登记过什么的唯一原始记录。
  const termsName = "terminology.md";
  const termsBody = [
    "# 术语提取流程（融合提取，与翻译同一轮调用）",
    "",
    "顺序：模型在**轮 1** 调用 `register_terms` 工具 → 补救层作为工具执行体判定（逐字见于原文、",
    "不与累积词表重复）→ 判定经 `toolResult` 回灌给模型 → 候选卡片 `state/cards.json`",
    "→ 作者确认后才进 `terminology/*.json`。",
    "",
    "`state/pending-terms.json` 是**入队缓冲**，抽干成卡片后归零——它为 0 不代表没提取到词。",
    "",
  ];
  /** 从历史里取本章所有尝试发起过的 register_terms 参数（轮 1 的全部产出） */
  const registrationsOf = (chapterId) => rows
    .filter((r) => String(r.label ?? "").endsWith(`:${chapterId}`))
    .flatMap((r) => (Array.isArray(r.toolCalls) ? r.toolCalls : []))
    .filter((c) => c?.name === "register_terms");

  for (const chapterId of chapterIds) {
    const calls = registrationsOf(chapterId);
    termsBody.push(
      "---",
      "",
      `## ${chapterId} · 模型登记的 \`register_terms\` 参数原文`,
      "",
      calls.length > 0
        ? calls.map((c, i) => [`### 第 ${i + 1} 次登记（id ${c.id}）`, "", fence(JSON.stringify(c.arguments, null, 1))].join("\n")).join("\n\n")
        : "（本章一次 register_terms 都没调用——若本章够长，这就是哑火，翻译侧会另发告警）",
      "",
    );
  }
  // 跨章一致性：同一个 ja 在各章拿到的 zh 并排摆出来。纯机器统计，不下判断。
  // 累积词表（EX-05）存在的理由就是让后一章沿用前一章的译法，这张表是它的体检。
  const perChapter = new Map();
  for (const chapterId of chapterIds) {
    for (const call of registrationsOf(chapterId)) {
      for (const t of call.arguments?.terms ?? []) {
        if (!t?.ja) continue;
        if (!perChapter.has(t.ja)) perChapter.set(t.ja, new Map());
        perChapter.get(t.ja).set(chapterId, t.zh ?? "");
      }
    }
  }
  const divergent = [...perChapter.entries()].filter(([, m]) => new Set(m.values()).size > 1);
  termsBody.push(
    "---",
    "",
    "## 跨章译法一致性（机器统计，未加判断）",
    "",
    `本轮共登记 ${perChapter.size} 个原文词；其中 **${divergent.length} 个在不同章拿到了不同译法**。`,
    "",
    divergent.length > 0
      ? [`| 原文 | ${chapterIds.join(" | ")} |`, `|---|${chapterIds.map(() => "---").join("|")}|`,
        ...divergent.map(([ja, m]) => `| ${ja} | ${chapterIds.map((c) => m.get(c) ?? "—").join(" | ")} |`)].join("\n")
      : "（没有分歧）",
    "",
  );

  for (const [file, title] of [
    ["state/cards.json", "候选卡片 cards.json（补救层过滤后）"],
    ["state/pending-terms.json", "待审 pending-terms.json"],
    ["state/terminology-status.json", "术语状态 terminology-status.json"],
  ]) {
    const data = await readJson(join(workspaceRoot, ...file.split("/")));
    termsBody.push(
      "---",
      "",
      `## ${title}`,
      "",
      `\`${file}\`${Array.isArray(data) ? ` · ${data.length} 条` : ""}`,
      "",
      fence(JSON.stringify(data, null, 1)),
      "",
    );
  }
  termsBody.push("---", "", "## 已确认档案 terminology/*.json", "");
  for (const archive of ["terms", "names", "puns", "onomatopoeia", "voice", "no-translate", "pre-dict", "post-dict"]) {
    const data = await readJson(join(workspaceRoot, "terminology", `${archive}.json`));
    const count = Array.isArray(data) ? data.length : (data === null ? "读不到" : "非数组");
    termsBody.push(`- \`terminology/${archive}.json\`：${count} 条${Array.isArray(data) && data.length > 0 ? "\n\n" + fence(JSON.stringify(data, null, 1)) + "\n" : ""}`);
  }
  termsBody.push("", "> 档案为空是**预期**：融合提取产出的是候选，作者确认后才写进档案（ADR-0007）。", "");
  await writeFile(join(outDir, termsName), termsBody.join("\n"), "utf8");
  files.push(termsName);
  index.push("", "## 术语提取流程", "", `- [${termsName}](${encodeURI(termsName)}) — 尾块原文 → 候选卡片 → 待审 → 已确认档案`, "");

  await writeFile(join(outDir, "00-索引.md"), [
    "# 本轮跑批的完整原始输出",
    "",
    "全部为**未加工原文**：思考块全文、响应全文、逐条判定所指的原文与译文段落。",
    "没有摘录，没有改写。",
    "",
    `工作区：\`${workspaceRoot}\``,
    "",
    ...index,
  ].join("\n"), "utf8");

  return { dir: outDir, files: ["00-索引.md", ...files] };
}
