import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rendererRoot = resolve(appRoot, "renderer");
const publicRoot = resolve(rendererRoot, "public");
const stylesRoot = resolve(rendererRoot, "styles");
// 界面外壳的源文件。它住在 renderer 下而不是 docs 下，是因为它**是源码**：
// 应用的 CSS、DOM 骨架、运行时脚本全从这一份切出来。放进 docs 会让「文档」
// 变成构建依赖——藏掉文档就构建不了，那种耦合不该存在。
const sourcePath = resolve(rendererRoot, "shell", "ui-shell.html");

const source = await readFile(sourcePath, "utf8");
const style = source.match(/<style>([\s\S]*?)<\/style>/i)?.[1];
const bodySource = source.match(/<body>([\s\S]*?)<\/body>/i)?.[1];
const script = source.match(/<script>([\s\S]*?)<\/script>/i)?.[1];
const body = bodySource?.replace(/<script[\s\S]*?<\/script>/gi, "");

if (!style || body === undefined || !script) {
  throw new Error(`Could not extract prototype sections from ${sourcePath}`);
}

const indexHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <title>lightee</title>
</head>
<body>${body.trim()}
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
`;

const runtime = `/* Generated from renderer/shell/ui-shell.html by scripts/sync-ui-shell.mjs. */
const stage = document.getElementById("stage");
const label = document.getElementById("label");
const prev = document.getElementById("prev");
const next = document.getElementById("next");
if (!stage || !label || !prev || !next) {
  throw new Error("Lightee prototype shell is incomplete");
}
${script.trim()}
`;

await mkdir(publicRoot, { recursive: true });
await mkdir(stylesRoot, { recursive: true });
await writeFile(resolve(rendererRoot, "index.html"), indexHtml, "utf8");
await writeFile(resolve(stylesRoot, "ui-shell.css"), `/* Generated from renderer/shell/ui-shell.html. */\n${style.trim()}\n`, "utf8");
await writeFile(resolve(publicRoot, "ui-shell-runtime.js"), runtime, "utf8");

console.log(`Synced prototype -> ${resolve(rendererRoot, "index.html")}`);
