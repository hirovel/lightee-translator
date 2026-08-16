import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recoverWorkspaceFileTransactions, withWorkspaceFileTransaction } from "../src/file-transaction.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function root() {
  const value = await mkdtemp(join(tmpdir(), "lightee-fstx-"));
  roots.push(value);
  await mkdir(join(value, "state"), { recursive: true });
  return value;
}

describe("workspace file transaction", () => {
  it("rolls back changed and newly created files when the operation fails", async () => {
    const ws = await root();
    const existing = join(ws, "source", "manifest.json");
    const created = join(ws, "source", "v01", "ch001.md");
    await mkdir(join(ws, "source"), { recursive: true });
    await writeFile(existing, "before");
    await expect(withWorkspaceFileTransaction(ws, [existing, created], async () => {
      await writeFile(existing, "after");
      await mkdir(join(ws, "source", "v01"), { recursive: true });
      await writeFile(created, "new");
      throw new Error("injected failure");
    })).rejects.toThrow("injected failure");
    expect(await readFile(existing, "utf8")).toBe("before");
    await expect(readFile(created, "utf8")).rejects.toThrow();
  });

  it("recovers a prepared journal after a simulated process crash", async () => {
    const ws = await root();
    const target = join(ws, "book.yaml");
    await writeFile(target, "after");
    const tx = join(ws, "state", "fs-transactions", "fstx-crash");
    await mkdir(tx, { recursive: true });
    await writeFile(join(tx, "0.bin"), "before");
    await writeFile(join(tx, "journal.json"), JSON.stringify({ version: 1, id: "fstx-crash", phase: "prepared", entries: [{ path: "book.yaml", kind: "file", data: "0.bin" }] }));
    expect(await recoverWorkspaceFileTransactions(ws)).toBe(1);
    expect(await readFile(target, "utf8")).toBe("before");
  });

  it("keeps committed data and only cleans the journal", async () => {
    const ws = await root();
    const target = join(ws, "book.yaml");
    await writeFile(target, "after");
    const tx = join(ws, "state", "fs-transactions", "fstx-committed");
    await mkdir(tx, { recursive: true });
    await writeFile(join(tx, "journal.json"), JSON.stringify({ version: 1, id: "fstx-committed", phase: "committed", entries: [] }));
    expect(await recoverWorkspaceFileTransactions(ws)).toBe(0);
    expect(await readFile(target, "utf8")).toBe("after");
  });
});
