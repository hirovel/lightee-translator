/**
 * 内容出处不变量 —— 仓库里不得残留真实作品的内容标记（IV-02）。
 *
 * 付过的学费：2026-08 转公开前用 git filter-repo 清除了取自某部已出版轻小说的
 * fixture 与演示文本。那次清理按**文件**做，于是漏掉了三类按**文本**存在的残余，
 * 全部是事后逐一撞见的：
 *   - verify-cli 头注仍写着「样本: 用《…》第1话原文构造」——文件早换成原创，注释像一份自认；
 *   - 演示审校样例里的换皮句、测试夹具里的原作角色名（真昼 / 周 / 朝比奈）；
 *   - fixtures/reference/ 里朋友的人译全文（17KB 真实作品译文）仍被 git 追踪，
 *     差一次 `git add -A` 就进公开仓库。
 *
 * 因此本测试扫的不是文件清单而是**git 追踪的全部文本**——恰好等于会被推上远端的东西。
 * 判据同 IV-01：宁可漏、不可吵。标记词只收录确凿属于被清除作品的专名与独有词形，
 * 不收普通词。豁免：命中行或其上一行写 `// invariant-allow: <理由>`。
 */
import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SELF = "tests/invariants/content-provenance.test.ts";

/** 只扫文本类扩展名；图标、二进制不读 */
const TEXT_EXT = /\.(ts|mts|cts|js|mjs|cjs|html|css|md|json|txt|yaml|yml|ps1)$/;

/**
 * 被清除作品的内容标记。每一条都必须是**只可能来自那部作品**的专名或独有词形；
 * 一旦有合法用途出现，收窄或删除该条——总在响的警报等于没有警报。
 */
const BANNED_MARKERS = [
  "邻家天使",
  "お隣の天使",
  "椎名真昼",
  "藤宮周",
  "真昼",
  "朝比奈",
  "アサヒナ",
  "遼君",
  "朝ヒナ",
  "おいふぃね",
];

function trackedTextFiles(): Array<{ path: string; text: string }> {
  // -z + NUL 分隔：默认输出会把非 ASCII 文件名转成带引号的八进制转义，中文文件名会读不到
  const listed = execSync("git ls-files -z", { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\0")
    .map((line) => line.trim())
    .filter((line) => line && line !== SELF && TEXT_EXT.test(line));
  return listed.map((path) => ({ path, text: readFileSync(join(REPO_ROOT, path), "utf8") }));
}

function isAllowed(lines: string[], index: number): boolean {
  for (const candidate of [lines[index], lines[index - 1]]) {
    const reason = /(?:\/\/|<!--|#)\s*invariant-allow:\s*(.*?)\s*(?:-->)?$/.exec(candidate ?? "")?.[1]?.trim();
    if (reason) return true;
  }
  return false;
}

describe("内容出处（IV-02）", () => {
  it("git 追踪的文本里没有被清除作品的内容标记", () => {
    const offenders: string[] = [];
    for (const file of trackedTextFiles()) {
      const lines = file.text.split(/\r?\n/);
      lines.forEach((line, index) => {
        const hit = BANNED_MARKERS.find((marker) => line.includes(marker));
        if (hit && !isAllowed(lines, index)) offenders.push(`${file.path}:${index + 1} 含「${hit}」`);
      });
    }
    expect(offenders, `真实作品的内容标记不得入库：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("朋友的人译对照材料不被 git 追踪", () => {
    const tracked = execSync("git ls-files packages/engine/fixtures/reference", { cwd: REPO_ROOT, encoding: "utf8" }).trim();
    expect(tracked, "fixtures/reference/ 是真实作品的人译，只许留在本地磁盘").toBe("");
  });
});
