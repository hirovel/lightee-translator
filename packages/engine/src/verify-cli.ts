/**
 * CLI 全流程端到端验证（真实 LLM）。
 *
 * 样本: 下方内联的自撰日文片段（拆半成 2 章 TXT）→ 完整流水线。
 * 刻意不用散文 fixture 文件：仓库里躺着一篇小说文件，就是「往里粘真书更方便」的斜坡。
 *   import → Terminologist(真实) → translate(真实) → review → approved
 *
 * 用法: node --experimental-strip-types src/verify-cli.ts [model]
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace } from "./workspace.ts";
import { importTxtBook } from "./txt-import.ts";
import { runTranslate } from "./cli-pipeline.ts";
import { LlmRuntime } from "./llm-runtime.ts";

// 自撰原创片段（森村透 / 桧山灯，与测试夹具同一套虚构人物）。约 20 段，够流水线跑出术语登记与检查。
const JA = [
  "　放課後の屋上には、まだ夏の匂いが残っていた。",
  "",
  "　森村透が錆びた扉を押し開けると、フェンスの前に桧山灯が立っていた。",
  "",
  "「……まだ帰らないのか」",
  "",
  "「森村くんこそ」",
  "",
  "　風が吹いて、彼女は湿った髪を耳にかけた。",
  "",
  "「ここ、電波が入らないんだ。だから静か」",
  "",
  "　静かなのは電波のせいではないだろう、と透は思ったが、口には出さなかった。",
  "",
  "「明日、日直だったよな」",
  "",
  "「覚えてたの」",
  "",
  "「黒板、消しておいた」",
  "",
  "　灯は少しだけ目を見開いて、それから小さく頷いた。",
  "",
  "「ありがと」",
  "",
  "　夕日がフェンスの影を長く引き延ばして、二人の足元まで届いていた。",
  "",
  "「明日も来る？」",
  "",
  "「たぶん」",
  "",
  "　扉が閉まる音がして、屋上にはまた風だけが残った。",
].join("\n");

async function main() {
  const modelRef = process.argv[2] ?? "deepseek/deepseek-v4-flash";
  console.log(`=== CLI 全流程端到端验证 ===`);
  console.log(`模型: ${modelRef}\n`);

  // 构造 2 章 TXT（拆半）
  const half = Math.floor(JA.length / 2);
  const ch1 = JA.slice(0, half);
  const ch2 = JA.slice(half);
  const txt = `第1章 与天使相遇\n\n${ch1}\n\n第2章 雨中的对话\n\n${ch2}`;

  const dir = mkdtempSync(join(tmpdir(), "qx-e2e-"));
  const ws = await createWorkspace(dir, { name: "屋上之灯测试", srcLang: "ja" });
  writeFileSync(join(dir, "book.txt"), txt, "utf-8");
  await importTxtBook(join(dir, "book.txt"), ws);
  console.log(`工作区: ${dir}`);
  console.log(`导入: 2 章\n`);

  const runtime = LlmRuntime.create();

  // EX-07 / ADR-0007：导入即可翻，没有「先提取再确认」的第一步了。
  // 术语随翻译逐章长出来，跑完之后再看词表长成什么样。
  console.log(`① 全流程翻译（导入即可翻）...`);
  const step2 = await runTranslate({
    workspace: ws,
    config: {
      project: { name: "屋上之灯测试", srcLang: "ja", tgtLang: "zh" },
      agents: {
        terminologist: { model: modelRef, thinking: "max" },
        translator: { model: modelRef, thinking: "high" },
        reviewer: { model: modelRef, thinking: "max" },
        orchestrator: { model: modelRef, thinking: "high" },
      },
      translation: { mode: "balanced", concurrency: 1, batchChars: 2000 },
    },
    llm: runtime,
  });

  console.log(`approved: ${step2.approved.join(", ")}`);
  console.log(`stuck: ${step2.stuck.join(", ")}`);
  console.log(`② 累积词表: ${step2.terminologyCount} 条`);
  // invariant-allow: 只读诊断输出，事后打印一次，不参与任何读改写循环——原子写保证读不到半个文件
  if (existsSync(join(dir, "terminology", "names.json"))) {
    // invariant-allow: 同上——诊断 CLI 的一次性读取，锁串行化对它没有意义
    const names = JSON.parse(readFileSync(join(dir, "terminology", "names.json"), "utf-8"));
    console.log(`   names.json: ${names.map((n: { ja: string; zh: string }) => `${n.ja}→${n.zh}`).join(", ")}`);
  }

  // 检查译文落盘
  for (const id of step2.approved) {
    const p = join(dir, "translations", `${id}_zh.md`);
    if (existsSync(p)) {
      const tr = readFileSync(p, "utf-8");
      console.log(`\n--- ${id} 译文（前 150 字）---`);
      console.log(tr.slice(0, 150));
    }
  }

  const ok = step2.approved.length >= 1;
  console.log(`\n${ok ? "✅ 端到端全流程通过" : "❌ 未完成"}`);
}

main().catch((e) => {
  console.error("\n❌ 失败:", e.message);
  process.exit(1);
});
