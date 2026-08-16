import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const relative of [".artifacts", ".tmp", "dist", "dist-main"]) {
  await rm(resolve(appRoot, relative), { recursive: true, force: true });
}
console.log("Electron generated artifacts and temporary profiles removed");
