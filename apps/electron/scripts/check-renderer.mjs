import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const html = await readFile(resolve(appRoot, "dist/index.html"), "utf8");

if (html.includes("unsafe-eval")) {
  throw new Error("Renderer CSP must not include unsafe-eval");
}
if (/https?:\/\//i.test(html)) {
  throw new Error("Production renderer HTML contains a remote URL");
}
try {
  await access(resolve(appRoot, "dist/ui-shell-runtime.js"));
} catch {
  throw new Error("Prototype compatibility runtime was not copied to dist");
}
if (!html.includes("type=\"module\"")) {
  throw new Error("Renderer module entry is missing");
}

/**
 * 悬空引用扫描。
 *
 * ui-shell-runtime 是从设计稿生成的一整块经典脚本，没有模块边界、也没有类型检查——
 * 删掉一段代码时漏掉别处对它的引用，产物照样构建通过，直到运行时才炸成
 * 「Renderer boot failed: xxx is not defined」。实测发生过：审校规则整段下线时，
 * 翻译指南的输入框还在用那段里的一个转义函数。
 *
 * 这里只做一件事：找出**被当成函数调用、却在本文件里找不到声明**的名字。
 * 判据保守——凡是拿不准的一律放行，宁可漏报也不能让构建对着误报停下来。
 */
const runtimeSource = await readFile(resolve(appRoot, "dist/ui-shell-runtime.js"), "utf8");
// 注释里提到一个函数名不是调用它。先把注释抹掉，否则一句「renderAiSettings() 用真实
// models.json 渲染」这样的说明就会被当成悬空引用报出来——误报比不报更快让人关掉检查。
// 模板字符串里的 HTML 注释一并抹掉：设计稿的说明就写在 `<!-- -->` 里，也会提到函数名。
const runtime = runtimeSource
  .replace(/<!--[\s\S]*?-->/g, " ")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:'"\\])\/\/[^\n]*/g, "$1");
const declared = new Set([
  ...runtime.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g),
  ...runtime.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g),
  // 形参与解构：`function f(onChange)` 里的 onChange 也会以 `onChange(` 的样子出现
  ...runtime.matchAll(/[({,]\s*([A-Za-z_$][\w$]*)\s*(?=[,)=])/g),
].map((match) => match[1]));
// CSS 函数写在模板字符串里，长得和调用一模一样；JS 内置与宿主 API 同理。
const ignored = new Set([
  "min", "max", "clamp", "var", "rgba", "rgb", "hsl", "hsla", "calc", "blur", "translateX", "translateY",
  "url", "linear-gradient", "cubic-bezier", "color-mix", "translate", "scale", "rotate", "drop-shadow",
  "if", "for", "while", "switch", "catch", "return", "typeof", "new", "delete", "void", "function",
  "class", "super", "this", "do", "else", "try", "finally", "await", "yield", "of", "in", "instanceof", "throw",
  "Object", "Array", "String", "Number", "Boolean", "Math", "JSON", "Date", "RegExp", "Promise", "Set",
  "Map", "WeakMap", "Error", "Symbol", "URLSearchParams", "URL", "Blob", "FileReader", "Intl",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame",
  "cancelAnimationFrame", "queueMicrotask", "structuredClone", "alert", "confirm", "prompt", "fetch",
  "console", "document", "window", "navigator", "localStorage", "sessionStorage", "getComputedStyle",
  "matchMedia", "CustomEvent", "Event", "MutationObserver", "ResizeObserver", "IntersectionObserver",
]);
const dangling = [...new Set([...runtime.matchAll(/(?<![.\w$'"-])([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]))]
  .filter((name) => !declared.has(name) && !ignored.has(name));
if (dangling.length > 0) {
  throw new Error(`ui-shell-runtime.js 里有悬空引用（调用了本文件没有声明的名字）：${dangling.join(", ")}`);
}

console.log("Renderer CSP/build checks passed");
