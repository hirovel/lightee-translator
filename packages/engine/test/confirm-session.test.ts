/**
 * confirm-session 测试：裁决会话（无 UI 依赖，CLI/TUI/Electron 三端口复用）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspace, type Workspace } from "../src/workspace.ts";
import { buildCard } from "@lightee/core/evidence-card";
import {
  createSession,
  loadSession,
  currentCard,
  verdict,
  finishSession,
  type SessionAction,
} from "../src/confirm-session.ts";

let dir: string;
let ws: Workspace;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lightee-conf-"));
  ws = await createWorkspace(dir, { name: "确认测试" });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const CARDS = [
  buildCard({
    ja: "森村透",
    reading: "とおる",
    type: "name",
    context: "「森村透(とおる)は……」",
    candidates: [
      { zh: "森村透", confidence: 0.9, evidence: [{ source: "web", url: "https://official.example", snippet: "官方译名" }] },
      { zh: "森村彻", confidence: 0.5 },
    ],
  }),
  buildCard({ ja: "アイテムボックス", type: "term", context: "アイテムボックスを取り出す", candidates: [{ zh: "道具箱", confidence: 0.8 }] }),
];

describe("confirm-session", () => {
  it("createSession 写 cards + session 文件", async () => {
    const s = await createSession(ws, CARDS);
    expect(s.cards).toHaveLength(2);
    expect(existsSync(join(ws.root, "state", "cards.json"))).toBe(true);
    expect(existsSync(join(ws.root, "state", "confirm-session.json"))).toBe(true);
  });

  it("currentCard 顺序 + 裁决前进", async () => {
    const s = await createSession(ws, CARDS);
    expect(currentCard(s)!.ja).toBe("森村透");
    await verdict(ws, s, { action: "accept", chosenZh: "森村透" });
    expect(currentCard(s)!.ja).toBe("アイテムボックス");
  });

  it("拒绝跨进程 stale session 写入而不覆盖较新的裁决", async () => {
    const current = await createSession(ws, CARDS);
    const stale = await loadSession(ws);
    expect(stale).not.toBeNull();
    await verdict(ws, current, { action: "accept", chosenZh: "森村透" });
    await expect(verdict(ws, stale!, { action: "skip" })).rejects.toMatchObject({ code: "conflict" });
    const recovered = await loadSession(ws);
    expect(recovered?.index).toBe(1);
    expect(recovered?.verdicts).toHaveLength(1);
  });

  it("不会在 session 文件被删除后提交旧裁决", async () => {
    const current = await createSession(ws, CARDS);
    await verdict(ws, current, { action: "accept", chosenZh: "森村透" });
    await rm(join(ws.root, "state", "confirm-session.json"), { force: true });
    await expect(finishSession(ws, current)).rejects.toMatchObject({ code: "conflict" });
    const repository = new (await import("@lightee/core/terminology-repository")).TerminologyRepository(ws.root);
    expect((await repository.readSnapshot()).revision).toBe(0);
  });

  it("裁决 m（自定义）支持", async () => {
    const s = await createSession(ws, CARDS);
    await verdict(ws, s, { action: "modify", chosenZh: "森村透同学" });
    expect(currentCard(s)!.ja).toBe("アイテムボックス");
  });

  it("裁决 s（跳过）前进", async () => {
    const s = await createSession(ws, CARDS);
    await verdict(ws, s, { action: "skip" });
    expect(currentCard(s)!.ja).toBe("アイテムボックス");
  });

  it("finishSession：应用裁决写术语表（skip 不进）", async () => {
    const s = await createSession(ws, CARDS);
    await verdict(ws, s, { action: "accept", chosenZh: "森村透" });
    await verdict(ws, s, { action: "skip" });
    const applied = await finishSession(ws, s);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.ja).toBe("森村透");
    expect(applied[0]!.zh).toBe("森村透");
    // 术语表落盘
    const names = JSON.parse(await readFile(join(ws.root, "terminology", "names.json"), "utf-8"));
    expect(names).toHaveLength(1);
    expect(names[0]!.ja).toBe("森村透");
    // session 文件清理
    expect(existsSync(join(ws.root, "state", "confirm-session.json"))).toBe(false);
    const status = JSON.parse(await readFile(join(ws.root, "state", "terminology-status.json"), "utf8"));
    expect(status).toMatchObject({ status: "confirmed", cardCount: 2, pendingCount: 0, confirmedCount: 2 });
  });

  it("loadSession 恢复进度（中途退出再继续）", async () => {
    const s = await createSession(ws, CARDS);
    await verdict(ws, s, { action: "accept", chosenZh: "森村透" });
    // 模拟新会话加载
    const restored = await loadSession(ws);
    expect(restored).not.toBeNull();
    expect(currentCard(restored!)!.ja).toBe("アイテムボックス");
  });

  it("无 session 文件 → 返回 null", async () => {
    expect(await loadSession(ws)).toBeNull();
  });

  it("parseAction：CLI/TUI 统一裁决输入解析", async () => {
    const { parseAction } = await import("../src/confirm-session.ts");
    expect(parseAction("1", CARDS[0]!)).toEqual({ action: "accept", chosenZh: "森村透" });
    expect(parseAction("m 森村透同学")).toEqual({ action: "modify", chosenZh: "森村透同学" });
    expect(parseAction("s")).toEqual({ action: "skip" });
  });
});
