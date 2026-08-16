/**
 * 阶段 0 模型验证：真实文本翻译质量测试。
 *
 * 用法:
 *   node --experimental-strip-types src/verify-model.ts
 *     （默认用 fixtures/sample-hashire-melos.txt —— 太宰治《走れメロス》青空文库公共领域）
 *   node --experimental-strip-types src/verify-model.ts <file> [thinking] [model]
 */
import { LlmRuntime } from "./llm-runtime.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SAMPLE = path.join(__dirname, "..", "fixtures", "sample-hashire-melos.txt");

// 真实文本的术语表（走れメロス 人物名）
const TERMS = [
  { ja: "メロス", zh: "美乐斯", type: "person" },
  { ja: "セリヌンティウス", zh: "塞利努提乌斯", type: "person" },
  { ja: "ディオニス", zh: "狄奥尼斯", type: "person" },
  { ja: "アレキス", zh: "阿列基斯", type: "person" },
  { ja: "シラクス", zh: "叙拉古", type: "place" },
];

const SYSTEM_PROMPT = `你是轻小译（Lightee）的译官（Translator Agent）。翻译日本文学作品/轻小说为中文。

规则：
1. 严格遵守术语表，不得更改既定译法
2. 保留对话「」格式（译文中对话也用中文「」）
3. 译文保持文学性：对话口语化、叙述流畅、角色语气鲜明
4. 保留原文段落结构
5. 只输出译文，不要解释

术语表：
${TERMS.map((t) => `- ${t.ja} → ${t.zh}（${t.type}）`).join("\n")}`;

async function main() {
  const samplePath = process.argv[2] ?? DEFAULT_SAMPLE;
  const thinking = process.argv[3] ?? "high";
  const modelRef = process.argv[4] ?? "deepseek/deepseek-v4-flash";

  const sample = fs.readFileSync(samplePath, "utf-8");
  console.log(`=== 轻小译 翻译质量验证 ===`);
  console.log(`样本: ${path.basename(samplePath)}（${sample.length} 字符）`);
  console.log(`模型: ${modelRef} (thinking=${thinking})\n`);

  const runtime = LlmRuntime.create();
  if (!runtime.getModel(modelRef)) {
    console.error(`❌ 模型 ${modelRef} 未找到`);
    process.exit(1);
  }

  console.log("--- 原文（前 300 字）---");
  console.log(sample.slice(0, 300) + (sample.length > 300 ? "..." : ""));

  const started = Date.now();
  const result = await runtime.complete(
    modelRef,
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: sample },
    ],
    { thinking }
  );
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log("\n--- 译文 ---");
  console.log(result.text);
  console.log("\n--- 统计 ---");
  console.log(`耗时: ${elapsed}s`);
  console.log(`stopReason: ${result.stopReason}`);
  if (result.usage) {
    console.log(`token: input=${result.usage.input} output=${result.usage.output}${result.usage.cacheRead ? ` cacheRead=${result.usage.cacheRead}` : ""}`);
  }
  console.log(`reasoning: ${result.reasoning?.length ?? 0} 字符`);

  // 质量检查
  const checks: string[] = [];
  const drift = TERMS.filter((t) => !result.text.includes(t.zh));
  checks.push(drift.length === 0 ? "✅ 术语表全部遵循" : `⚠️ 术语漂移: ${drift.map((t) => `${t.ja}→${t.zh}`).join(", ")}`);
  checks.push(/「[^」]+」/.test(result.text) ? "✅ 对话「」格式保留" : "⚠️ 未检测到「」对话格式");
  const dialogueCount = (result.text.match(/「/g) ?? []).length;
  const srcDialogueCount = (sample.match(/「/g) ?? []).length;
  checks.push(
    Math.abs(dialogueCount - srcDialogueCount) <= 2
      ? `✅ 对话数量一致（原文 ${srcDialogueCount} → 译文 ${dialogueCount}）`
      : `⚠️ 对话数量差异（原文 ${srcDialogueCount} → 译文 ${dialogueCount}）`
  );
  checks.push(
    result.text.includes("。")
      ? "✅ 中文标点正常"
      : "⚠️ 缺少中文句号"
  );
  console.log("\n--- 质量检查 ---");
  for (const c of checks) console.log(c);
}

main().catch((e) => {
  console.error("\n❌ 失败:", e.message);
  process.exit(1);
});
