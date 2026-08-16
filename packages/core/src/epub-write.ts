/**
 * EPUB 导出器（再生式）：jszip 自研生成标准 EPUB3，干净中文排版。
 *
 * 设计（见 docs/lightee-wiki.md）:
 *   - 非还原式：不套原排版，生成为中文优化的干净 EPUB3
 *   - 一卷一本 EPUB；章节 xhtml 开头 = 插图页（图+图注）
 *   - 格式标记还原: *斜体* → em · **粗体** → strong · 【注】→ 行内括注（脚注二期）
 */

import JSZip from "jszip";

// ===== 类型 =====
export interface EpubExportChapter {
  id: string;
  title: string;
  content: Array<{ kind: "text" | "heading"; text: string }>;
  images?: Array<{ name: string; caption?: string }>;
}

export interface EpubExportOptions {
  title: string;
  authors?: string[];
  lang?: string;
  volumeLabel?: string;
  chapters: EpubExportChapter[];
  /** 插图文件: 资源名 → 二进制 */
  images?: Map<string, Buffer>;
}

// ===== 常量 =====
const MIMETYPE = "application/epub+zip";

const CSS = `/* Lightee 再生式 EPUB 排版 —— 干净中文阅读标准 */
body { font-family: "Noto Serif CJK SC", "Source Han Serif SC", serif; }
p {
  font-size: 1.05rem;
  line-height: 1.8;
  text-indent: 2em;
  margin: 0 0 0.2em 0;
}
h1 {
  font-size: 1.4rem;
  text-align: center;
  margin: 1.5em 0;
  font-weight: 600;
  text-indent: 0;
}
.title-page { text-align: center; margin-top: 30%; }
.title-page h1 { font-size: 1.8rem; }
.title-page .vol { font-size: 1.1rem; color: #555; }
.title-page .author { margin-top: 2em; color: #555; }
.image-page { text-align: center; margin: 1.5em 0; }
.image-page img { max-width: 100%; height: auto; }
.image-page .caption { font-size: 0.85rem; color: #666; margin-top: 0.5em; }
blockquote { margin: 1em 2em; color: #444; }
`;

// ===== 主入口 =====
export async function generateEpub(opts: EpubExportOptions): Promise<Buffer> {
  const zip = new JSZip();
  const lang = opts.lang ?? "zh";
  const images = opts.images ?? new Map<string, Buffer>();

  // 1. mimetype（EPUB 规范：必须第一个文件、无压缩）
  zip.file("mimetype", MIMETYPE, { compression: "STORE" });

  // 2. container.xml
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  );

  // 3. 章节 xhtml + 图片
  const chapterFiles: string[] = [];
  const manifestItems: Array<{ id: string; href: string; mediaType: string; properties?: string }> = [];

  // 卷首页
  const titlePageId = "title";
  zip.file("OEBPS/title.xhtml", titlePageXhtml(opts));
  manifestItems.push({ id: titlePageId, href: "title.xhtml", mediaType: "application/xhtml+xml" });
  chapterFiles.push("title.xhtml");

  for (const ch of opts.chapters) {
    const file = `${ch.id}.xhtml`;
    zip.file(`OEBPS/${file}`, chapterXhtml(ch, images));
    manifestItems.push({ id: ch.id, href: file, mediaType: "application/xhtml+xml" });
    chapterFiles.push(file);

    for (const img of ch.images ?? []) {
      const buf = images.get(img.name);
      if (!buf) continue;
      zip.file(`OEBPS/images/${img.name}`, buf);
      manifestItems.push({
        id: `img-${img.name.replace(/\.[a-z0-9]+$/i, "")}`,
        href: `images/${img.name}`,
        mediaType: imageMime(img.name),
      });
    }
  }

  // 4. nav.xhtml（EPUB3 TOC）
  zip.file("OEBPS/nav.xhtml", navXhtml(opts.chapters));
  manifestItems.push({
    id: "nav",
    href: "nav.xhtml",
    mediaType: "application/xhtml+xml",
    properties: "nav",
  });

  // 5. styles.css
  zip.file("OEBPS/styles.css", CSS);
  manifestItems.push({ id: "css", href: "styles.css", mediaType: "text/css" });

  // 6. content.opf
  zip.file("OEBPS/content.opf", contentOpf(opts, manifestItems, chapterFiles));

  return zip.generateAsync({ type: "nodebuffer", mimeType: MIMETYPE });
}

// ===== 章节 xhtml =====
function chapterXhtml(
  ch: EpubExportChapter,
  images: Map<string, Buffer>
): string {
  const body: string[] = [];

  // 章节标题：content 无 heading 时自动用 ch.title 生成 h1
  const hasHeading = ch.content.some((b) => b.kind === "heading");
  if (!hasHeading && ch.title) {
    body.push(`<h1>${mdToHtml(ch.title)}</h1>`);
  }

  // 插图页（章首集中展示）
  for (const img of ch.images ?? []) {
    if (!images.has(img.name)) continue;
    const caption = img.caption ? `<div class="caption">${escapeHtml(img.caption)}</div>` : "";
    body.push(
      `<div class="image-page"><img src="images/${img.name}" alt="${escapeHtml(img.caption ?? ch.title)}"/>${caption}</div>`
    );
  }

  for (const block of ch.content) {
    if (block.kind === "heading") {
      body.push(`<h1>${mdToHtml(block.text)}</h1>`);
    } else if (block.text.trim()) {
      // 正文流中的插图标记 → 行内插图（导出时保留位置）
      if (block.text.includes("[插图:")) {
        const parts: string[] = block.text.split(/\[插图: ([a-z0-9]+)\]/g);
        let html = "";
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          if (i % 2 === 1 && part) {
            const name = `${part}.jpg`;
            if (images.has(name)) {
              html += `<span class="image-page"><img src="images/${name}" alt=""/></span>`;
            }
          } else if (part) {
            html += mdToHtml(part);
          }
        }
        body.push(`<p>${html}</p>`);
      } else {
        body.push(`<p>${mdToHtml(block.text)}</p>`);
      }
    }
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh" xml:lang="zh">
<head>
  <title>${escapeHtml(ch.title)}</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
${body.join("\n")}
</body>
</html>`;
}

// ===== 卷首页 =====
function titlePageXhtml(opts: EpubExportOptions): string {
  const vol = opts.volumeLabel ? `<div class="vol">${escapeHtml(opts.volumeLabel)}</div>` : "";
  const author = opts.authors?.length
    ? `<div class="author">${opts.authors.map((a) => escapeHtml(a)).join(" / ")}</div>`
    : "";
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh" xml:lang="zh">
<head>
  <title>${escapeHtml(opts.title)}</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
<div class="title-page">
  ${vol}
  <h1>${escapeHtml(opts.title)}</h1>
  ${author}
</div>
</body>
</html>`;
}

// ===== nav TOC =====
function navXhtml(chapters: EpubExportChapter[]): string {
  const items = chapters
    .map((c) => `    <li><a href="${c.id}.xhtml">${escapeHtml(c.title)}</a></li>`)
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh" xml:lang="zh">
<head><title>目录</title></head>
<body>
<nav epub:type="toc"><ol>
${items}
</ol></nav>
</body>
</html>`;
}

// ===== content.opf =====
function contentOpf(
  opts: EpubExportOptions,
  items: Array<{ id: string; href: string; mediaType: string; properties?: string }>,
  spineOrder: string[]
): string {
  const manifest = items
    .map((i) => {
      const props = i.properties ? ` properties="${i.properties}"` : "";
      return `    <item id="${i.id}" href="${i.href}" media-type="${i.mediaType}"${props}/>`;
    })
    .join("\n");
  const spine = spineOrder
    .map((f) => {
      const id = f.replace(".xhtml", "");
      return `    <itemref idref="${id}"/>`;
    })
    .join("\n");
  const authors = (opts.authors ?? [])
    .map((a) => `    <dc:creator>${escapeXml(a)}</dc:creator>`)
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">lightee-${Date.now()}</dc:identifier>
    <dc:title>${escapeXml(opts.title)}</dc:title>
    ${authors}
    <dc:language>${opts.lang ?? "zh"}</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</meta>
  </metadata>
  <manifest>
${manifest}
  </manifest>
  <spine>
${spine}
  </spine>
</package>`;
}

// ===== 工具 =====
/** md 标记 → xhtml（*斜体* **粗体* 段落保持） */
function mdToHtml(text: string): string {
  let out = escapeHtml(text);
  // **粗体** 优先（防 * 嵌套冲突）
  out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return out;
}

function imageMime(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    default:
      return "image/jpeg";
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeXml(s: string): string {
  return escapeHtml(s);
}
