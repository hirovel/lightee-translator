/**
 * 演示工作区（README 截图用）——在 Electron 主进程内运行（LIGHTEE_HEADLESS_SCRIPT）。
 *
 * 与验收脚本的关键差别：**不隔离书架注册表**。隔离规则是防测试污染用户书架；
 * 这次相反——作者要求把演示工作区放上自己的真实书架（2026-08-14 批示），
 * 拉起方负责先停掉正开着的应用，避免两个进程写同一份注册表。
 *
 * 译文走真实模型（作者批准用 Key）：截图的主角是流水线产物（术语卡/确认队列），
 * 手捏这些文件可能拼出真实流水线不会产生的状态。
 *
 * 用法（拉起方设置）：
 *   LIGHTEE_DEMO_ROOT=<工作区目录>  LIGHTEE_DEMO_SOURCE=<ja txt 路径>
 */
import { mkdir } from "node:fs/promises";

const envelope = (command, payload) => ({ version: 1, requestId: `${command}-demo`, command, payload });

export default async function run({ ipcService }) {
  const root = process.env.LIGHTEE_DEMO_ROOT;
  const sourcePath = process.env.LIGHTEE_DEMO_SOURCE;
  if (!root || !sourcePath) { console.error("缺少 LIGHTEE_DEMO_ROOT / LIGHTEE_DEMO_SOURCE"); return 1; }
  const invoke = async (command, payload) => ipcService.invoke(envelope(command, payload));

  await mkdir(root, { recursive: true });
  const created = await invoke("workspace.create", { path: root, name: "屋上のひかり" });
  if (!created.ok) { console.error("workspace.create 失败", created.error); return 1; }
  const workspaceId = created.value.id;
  console.log(`工作区 ${workspaceId} → ${root}`);

  // 密钥与模型先探明——翻到一半才发现没 Key，钱已经花了一部分
  const providers = await invoke("ai.providers.list", { workspaceId });
  if (!providers.ok) { console.error("ai.providers.list 失败", providers.error); return 1; }
  const current = providers.value.providers.find((p) => p.id === providers.value.currentProvider);
  if (!current?.hasKey) { console.error(`服务商 ${providers.value.currentProvider} 没有可用密钥`); return 1; }
  console.log(`模型 ${providers.value.current} · 服务商 ${providers.value.currentProvider} · 档位 ${providers.value.currentThinking}`);

  const imported = await invoke("import.run", { workspaceId, sourcePath });
  if (!imported.ok) { console.error("import.run 失败", imported.error); return 1; }
  console.log(`导入 ${imported.value.chapters} 章`);

  const opened = await invoke("workspace.open", { path: root });
  if (!opened.ok) { console.error("workspace.open 失败", opened.error); return 1; }
  const chapterId = opened.value.volumes.flatMap((v) => v.chapters)[0]?.id;
  if (!chapterId) { console.error("导入后没有章节"); return 1; }

  const started = Date.now();
  const translated = await invoke("translate.run", { workspaceId, chapterId });
  console.log(`翻译 ${chapterId} · ${translated.ok ? translated.value.workflowStatus : "失败"} · ${Math.round((Date.now() - started) / 1000)}s`);
  if (!translated.ok) { console.error(translated.error); return 1; }

  // 确认队列里应躺着这一章登记的术语卡——它们就是截图的主角
  const confirmations = await invoke("confirm.list", { workspaceId });
  if (confirmations.ok) console.log(`待确认术语卡：${confirmations.value.cards?.length ?? 0} 张`);
  return 0;
}
